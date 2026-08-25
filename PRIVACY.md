# RiftOps privacy policy

**Effective date:** 2026-08-25

RiftOps is an open-source desktop companion for Riot games. It does not
operate a hosted account service and does not sell personal information.

## Information processed

RiftOps processes information needed to provide its local features:

- Riot Client and League Client process information, including local process
  state, lockfile data, and the temporary local credentials required to call
  the client API.
- App preferences, launch profiles, diagnostics, and optional saved Riot
  session data are stored on the user's computer. Windows saved-session data is
  protected with Windows DPAPI; users can remove saved sessions from RiftOps.
- If phone control is enabled, pairing and device-session tokens are held by
  the desktop app for the LAN session. Pairing sessions expire, can be revoked,
  and are removed when RiftOps exits.

RiftOps does not collect analytics, advertising identifiers, keystrokes, or
passwords. Riot authentication remains owned by the Riot Client; RiftOps does
not provide a Riot password field.

## Network requests

Depending on the features used, RiftOps connects to Riot's official client/API
services, Riot's Data Dragon service, CommunityDragon for optional game assets,
and the official GitHub Releases API for update checks. The desktop dashboard
and Riot proxy bind to loopback. Optional phone control uses HTTP on the user's
private local network and is not a cloud relay; it must not be exposed to the
public internet.

RiftOps does not send collected information to an unrelated analytics or
advertising provider. Riot and GitHub process requests under their own privacy
policies.

## Storage and deletion

Users can delete RiftOps settings, diagnostics, saved sessions, and cached
assets from the app or by removing the RiftOps user configuration/data
directory. Temporary phone sessions are kept only in memory and expire
automatically.

## Changes and contact

Material policy changes will be documented in this file. Privacy questions and
data-removal requests can be opened as a public issue in the
[RiftOps repository](https://github.com/HassanSalah120/RiftOps/issues). Do not
post Riot credentials, lockfile contents, or private diagnostic files in an
issue.
