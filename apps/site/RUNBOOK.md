# Site runbook

One-time setup for hobbots.app that lives outside this repository. The Cloudflare and domain steps come with [#189](https://github.com/otaviobarros/hobbots/issues/189).

## GitHub repository settings

- **Secret scanning** and **push protection** are on, under Settings › Advanced Security. GitHub then blocks a push that contains a known secret, such as a Cloudflare API token. Check with `gh api repos/otaviobarros/hobbots --jq .security_and_analysis`: `secret_scanning` and `secret_scanning_push_protection` read `enabled`.
- The [Site workflow](../../.github/workflows/site.yml) needs no secrets, so it runs the same for pull requests from forks.
