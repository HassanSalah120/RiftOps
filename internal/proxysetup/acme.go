package proxysetup

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/acme"

	"github.com/HassanSalah120/RiftOps/internal/certificate"
)

const (
	letsencryptDirectory = "https://acme-v02.api.letsencrypt.org/directory"
	duckDNSBaseURL       = "https://www.duckdns.org/update"
	maxDuckTokenLength   = 256
)

var duckDNSHostname = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.duckdns\.org$`)

// ProvisionOptions contains only short-lived setup input. The DuckDNS token
// is deliberately not part of settings and is never returned to callers.
type ProvisionOptions struct {
	Hostname string
	Token    string
	Email    string
	CertPath string
}

// Provision requests a publicly trusted certificate for a user's own DuckDNS
// hostname using ACME DNS-01. The private key is generated locally and written
// only to CertPath. The token is used in memory and cleared by the caller.
func Provision(ctx context.Context, options ProvisionOptions) (time.Time, error) {
	hostname, err := validateOptions(options)
	if err != nil {
		return time.Time{}, err
	}

	accountKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return time.Time{}, fmt.Errorf("generate ACME account key: %w", err)
	}
	client := &acme.Client{Key: accountKey, DirectoryURL: letsencryptDirectory}
	contact := []string(nil)
	if strings.TrimSpace(options.Email) != "" {
		contact = []string{"mailto:" + strings.TrimSpace(options.Email)}
	}
	if _, err := client.Register(ctx, &acme.Account{Contact: contact}, acme.AcceptTOS); err != nil {
		return time.Time{}, fmt.Errorf("register ACME account: %w", err)
	}

	order, err := client.AuthorizeOrder(ctx, []acme.AuthzID{{Type: "dns", Value: hostname}})
	if err != nil {
		return time.Time{}, fmt.Errorf("request certificate authorization: %w", err)
	}
	for _, authzURL := range order.AuthzURLs {
		authz, err := client.GetAuthorization(ctx, authzURL)
		if err != nil {
			return time.Time{}, fmt.Errorf("read certificate authorization: %w", err)
		}
		if authz.Status == acme.StatusValid {
			continue
		}
		challenge := findDNSChallenge(authz.Challenges)
		if challenge == nil {
			return time.Time{}, errors.New("certificate authority did not offer a DNS challenge")
		}
		record, err := client.DNS01ChallengeRecord(challenge.Token)
		if err != nil {
			return time.Time{}, fmt.Errorf("create DNS challenge record: %w", err)
		}
		if err := updateDuckDNSTXT(ctx, hostname, options.Token, record, false); err != nil {
			return time.Time{}, fmt.Errorf("publish DNS challenge: %w", err)
		}
		challengeErr := func() error {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			defer func() { _ = updateDuckDNSTXT(cleanupCtx, hostname, options.Token, "", true) }()
			if _, err := client.Accept(ctx, challenge); err != nil {
				return err
			}
			_, err := client.WaitAuthorization(ctx, authzURL)
			return err
		}()
		if challengeErr != nil {
			return time.Time{}, fmt.Errorf("complete DNS authorization: %w", challengeErr)
		}
	}

	ready, err := client.WaitOrder(ctx, order.URI)
	if err != nil {
		return time.Time{}, fmt.Errorf("wait for certificate order: %w", err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return time.Time{}, fmt.Errorf("generate certificate key: %w", err)
	}
	csrTemplate := &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: hostname, Organization: []string{"RiftOps local chat proxy"}},
		DNSNames: []string{hostname},
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, csrTemplate, leafKey)
	if err != nil {
		return time.Time{}, fmt.Errorf("create certificate request: %w", err)
	}
	der, _, err := client.CreateOrderCert(ctx, ready.FinalizeURL, csr, true)
	if err != nil {
		return time.Time{}, fmt.Errorf("issue certificate: %w", err)
	}
	if len(der) < 2 {
		return time.Time{}, errors.New("certificate authority returned no issuer chain")
	}
	leaf, err := x509.ParseCertificate(der[0])
	if err != nil {
		return time.Time{}, fmt.Errorf("parse issued certificate: %w", err)
	}
	chain := make([]*x509.Certificate, 0, len(der)-1)
	for _, raw := range der[1:] {
		issuer, parseErr := x509.ParseCertificate(raw)
		if parseErr != nil {
			return time.Time{}, fmt.Errorf("parse certificate issuer: %w", parseErr)
		}
		chain = append(chain, issuer)
	}
	if err := certificate.SavePKCS12(options.CertPath, leafKey, leaf, chain); err != nil {
		return time.Time{}, err
	}
	return leaf.NotAfter, nil
}

func findDNSChallenge(challenges []*acme.Challenge) *acme.Challenge {
	for _, challenge := range challenges {
		if challenge != nil && challenge.Type == "dns-01" {
			return challenge
		}
	}
	return nil
}

func validateOptions(options ProvisionOptions) (string, error) {
	hostname := strings.ToLower(strings.TrimSpace(options.Hostname))
	if !duckDNSHostname.MatchString(hostname) {
		return "", errors.New("hostname must be a single DuckDNS name such as riftops-hassan.duckdns.org")
	}
	if len(options.Token) == 0 || len(options.Token) > maxDuckTokenLength || strings.ContainsAny(options.Token, "\r\n\t ") {
		return "", errors.New("DuckDNS token is invalid")
	}
	if strings.TrimSpace(options.CertPath) == "" {
		return "", errors.New("certificate cache path is required")
	}
	return hostname, nil
}

func updateDuckDNSTXT(ctx context.Context, hostname, token, value string, clear bool) error {
	label := strings.TrimSuffix(hostname, ".duckdns.org")
	query := url.Values{}
	query.Set("domains", label)
	query.Set("token", token)
	if clear {
		query.Set("clear", "true")
	} else {
		query.Set("txt", value)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, duckDNSBaseURL+"?"+query.Encode(), nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 128))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || strings.TrimSpace(string(body)) != "OK" {
		// Never include the request URL: it contains the account token.
		return fmt.Errorf("DuckDNS rejected the TXT update (status %d)", response.StatusCode)
	}
	return nil
}

// MarshalStatus is used by diagnostics and intentionally contains no token or
// private-key material.
func MarshalStatus(hostname string, expiresAt time.Time) []byte {
	data, _ := json.Marshal(map[string]any{"hostname": hostname, "expiresAt": expiresAt.UTC().Format(time.RFC3339)})
	return data
}
