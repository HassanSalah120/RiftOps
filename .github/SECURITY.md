# Security Policy

The RiftOps project takes security, local data confidentiality, and anti-cheat compliance seriously. As a local-first application interacting with the League of Legends Client (LCU) on `localhost`, RiftOps is designed never to touch game memory, inject into processes, or send telemetry to external cloud servers.

## Supported Versions

Only the latest release branch and minor patch stream receive security updates and fixes.

| Version | Supported          |
| ------- | ------------------ |
| 2.8.x   | :white_check_mark: |
| < 2.8.0 | :x:                |

## Reporting a Vulnerability

If you discover a potential security vulnerability in RiftOps, please **do not open a public issue**. Instead, report it responsibly via one of the following channels:

1. **GitHub Private Vulnerability Reporting (Recommended)**:
   Navigate to the [Security Advisories](https://github.com/HassanSalah120/RiftOps/security/advisories) section of this repository and click **"Report a vulnerability"** to submit a confidential report directly to maintainers.

2. **Direct Maintainer Contact**:
   If needed, reach out to the project maintainer via [HassanSalah120](https://github.com/HassanSalah120).

### What to Include in Your Report
- A detailed description of the vulnerability.
- Clear steps or a safe proof-of-concept (PoC) to reproduce the issue.
- Affected components (e.g., Local Phone Companion listener, DPAPI / Keychain session vault, XMPP Chat Proxy, WebView2 frontend).
- Any potential impact or suggested mitigations.

## Response Process & SLA
- **Initial Acknowledgement**: Within 48 hours of receipt.
- **Triage & Assessment**: We will assess impact and verify reproduction within 5 business days.
- **Coordination & Release**: A fix will be developed, tested, and published as part of a new release accompanied by a public security advisory giving appropriate credit.

## Security Architecture Reference
For detailed documentation on local phone companion authorization, single-use token lifecycles, and route allowlists, see [SECURITY_AUDIT.md](../SECURITY_AUDIT.md).
