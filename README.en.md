# CF-Aur-Acc

<p align="center">
  A Cloudflare Worker script that reverse proxies the AUR RPC endpoint and git repo.
</p>

<p align="center">
  <strong>English</strong> | <a href="README.md">中文</a>
</p>

## Deploy

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Orange-Icepop/CF-Aur-Acc">
    <img alt="Deploy to Cloudflare" src="https://img.shields.io/badge/Deploy%20to-Cloudflare-f38020?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=111827">
  </a>
</p>

Remember to bind a custom domain (e.g. `aur.example.com`) to your worker, since `*.workers.dev` is nearly unavailable in Mainland China.

## Usage

Only tested on paru.

### paru

In `/etc/paru.conf`, change the following options:

```conf
[options]
AurUrl = https://aur.example.com
AurRpcUrl = https://aur.example.com/rpc
```

### yay

Execute the following command:

```bash
yay --aururl https://aur.example.com --aurrpcurl https://aur.example.com/rpc --save
```

Therefore, part of `~/.config/yay/config.json` should be like:

```json
{
  "aururl": "https://aur.example.com",
  "aurrpcurl": "https://aur.example.com/rpc"
}
```

## Principle

paru version 2.0+ and yay use RPC request to process search operations, and use `Git Smart HTTP` to get PKGBUILDs from AUR. 

The script reposts requests to `aur.archlinux.org`, and do the following work at the same time:

- Clean Cloudflare-injeced headers and `Accept-Encoding` header
- Do a 300s CDN cache for `GET /cgit/*` and `GET /rpc`
- Filter out unrelevant API endpoints and return 403 to pass the fishing website check
- Add `X-Robots-Tag: noindex, nofollow` to stop search engine from collecting it

## Security Warning

**The project has no authentication, and it shouldn't and won't have a built-in authentication.** It means that if being detected by a purposeful attacker, your free limit of 100k requests daily can be used up easily (despite meaningless). Make good protection of your URL endpoint knowledgement, or use Cloudflare services such as Access.
