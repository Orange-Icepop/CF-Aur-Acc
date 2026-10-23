# CF-Aur-Acc

<p align="center">
  一个能够反代AUR的RPC端点和PKGBUILD git仓库的Cloudflare Worker项目
</p>

<p align="center">
  <a href="README.en.md">English</a> | <strong>中文</strong>
</p>

## 部署

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Orange-Icepop/CF-Aur-Acc">
    <img alt="Deploy to Cloudflare" src="https://img.shields.io/badge/Deploy%20to-Cloudflare-f38020?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=111827">
  </a>
</p>

记得绑定一个自己的域名（下面以`aur.enample.com`为例），因为默认的`*.workers.dev`在中国大陆地区几乎不可用。

## 客户端使用

只在paru上测试过。

### paru

编辑`/etc/paru.conf`：

```conf
[options]
AurUrl = https://aur.example.com
AurRpcUrl = https://aur.example.com/rpc
```

### yay

执行以下命令：

```bash
yay --aururl https://aur.example.com --aurrpcurl https://aur.example.com/rpc --save
```

然后，`~/.config/yay/config.json`的应该有这样的配置：

```json
{
  "aururl": "https://aur.example.com",
  "aurrpcurl": "https://aur.example.com/rpc"
}
```

## 原理

paru（2.0版本以上）与yay对`aur.archlinux.org/rpc`进行RPC请求以实现搜索等操作，并使用`Git Smart HTTP`协议从AUR上获取PKGBUILD。

此项目在Cloudflare的边缘节点上将请求转发给`aur.archlinux.org`以实现跳板加速，在此期间：

- 清除了Cloudflare注入的请求头与`Accept-Encoding`请求头
- 在边缘节点上为`GET /cgit/*`和`GET /rpc`缓存300s
- 只转发AUR助手必须的API端点，对于其余端点返回403以避免钓鱼网站检查
- 添加`X-Robots-Tag: noindex, nofollow`以防止搜索引擎收录

## 安全警告

**本项目没有、不应该、也永远不会内置身份验证功能。**这意味着别有用心的攻击者一旦发现了你的服务，可以很快刷爆你的每天免费10万次请求（不是这攻击者有病吧图啥啊）。藏好你的服务URL，或者使用像Cloudflare Access这样的服务来限制客户端连接。