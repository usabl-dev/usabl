# Lab SSH public key (fingerprint check only)

This file is the **public** half of the shared classroom key in the team Drive folder
(see `../ansible-ui-team-setup.md` or ask the team for access). It does **not** grant access by itself.

## Verify your private key

After you download `rht_classroom.rsa` from the team Drive folder, save it as
`~/.ssh/rht_classroom.rsa` and confirm the fingerprint matches:

```
chmod 600 ~/.ssh/rht_classroom.rsa
ssh-keygen -lf ~/.ssh/rht_classroom.rsa
ssh-keygen -lf docs/demo/keys/rht_classroom.rsa.pub   # from the usabl clone root
```

Both commands must print the same `SHA256:` fingerprint.

## Spinning up your own lab instead

If you use the official lab UI (CREATE, then DOWNLOAD SSH KEY), your downloaded
`rht_classroom.rsa` is a **different** key pair. Its fingerprint will not match this file.
That is fine for SSH into your own workstation VM, but the usabl team workflow uses the
**shared** private key from the team Drive folder plus `docs/demo/open-aap-tunnel.sh` (in the usabl
clone) to reach the shared AAP API.

Never commit your private key. Never push `~/.ssh/rht_classroom.rsa`.
