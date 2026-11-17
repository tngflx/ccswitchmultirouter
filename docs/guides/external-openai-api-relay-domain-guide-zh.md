# 第三方 Agent API 域名中转配置指南

> 范围：本页只配置模型推理 API，不提供 Codex 当前会话查看、远程 Continue 或屏幕共享。
> 自有设备的无人值守查看与 Continue 采用单独的
> [Owner Remote 指南](codex-owner-remote-access.md)。Owner Remote 已实现独立的本机控制服务，
> 可在 **设置 → 连接与恢复 → 远程连接（所有者访问）** 中启用；默认关闭，需另行配置私有 HTTPS 链路并配对设备。
> 第三方 Agent API 的域名与 API Key 不会启用或授权 Owner Remote；源码与本机测试通过也不等于已完成你当前远程链路的端到端验证。

本文说明如何把 CC Switch 的“第三方 Agent API”通过一台有公网 IP 的中转机暴露成域名访问，例如：

```text
base_url = https://llm.example.com/v1
api_key  = ccsw_...
model    = gpt-5.4-mini
```

目标是让外部 Agent 只看到 OpenAI-compatible API，不接触 CC Switch 本机的 OAuth token、refresh token 或上游真实 API Key。

## 拓扑

推荐拓扑是：

```text
第三方 Agent
  -> https://llm.example.com/v1
  -> 公网中转机 Caddy/Nginx
  -> 私有链路
  -> 运行 CC Switch 的 Windows 机器 15722
  -> CC Switch External OpenAI API
  -> 已选择的后端模型源
```

CC Switch 本机建议使用独立的第三方 Agent API 端口，例如 `15722`。不要把它和 Codex/Multi Router 主代理端口 `15721` 混用。

## 前置条件

在运行 CC Switch 的 Windows 机器上：

- 第三方 Agent API 已启用。
- 服务来源已选择，例如 `OpenAI Official Backup (codex)`。
- SSH 反向隧道使用 `127.0.0.1`；私有 mesh 链路优先绑定指定私有网卡地址。
- 不要仅为远程访问就开放所有网卡；如果必须使用 `0.0.0.0`，防火墙须只允许经过验证的私有链路。
- 监听端口设置为 `15722`。
- 已生成 `ccsw_...` 访问 Key。
- 在本机验证与监听地址一致的 endpoint。SSH 方案使用 loopback：

```powershell
curl.exe http://127.0.0.1:15722/health
```

若只绑定私有网卡，loopback 不会监听；本机和中转机均验证该私有地址：

```powershell
curl.exe http://<CC_SWITCH_HOST_IP>:15722/health
```

## 方案 A：中转机通过 Tailscale 回连 CC Switch

家宽没有公网 IP、运营商 CGNAT、路由器不能端口转发时，可采用此私有链路。
按 owner/device 配置 mesh 访问策略，不要把加入同一网络当成所有设备都可以访问 API 的理由。

1. 在 Windows 机器和中转机上都安装并登录 Tailscale。
2. 在 Windows 机器上确认 Tailscale IP：

```powershell
tailscale ip -4
```

假设得到：

```text
100.118.73.52
```

3. 在中转机上测试能访问 CC Switch：

```bash
curl -i http://100.118.73.52:15722/health
```

返回 `200` 后，再配置域名反代。

### Caddy 配置

`/etc/caddy/Caddyfile`：

```caddyfile
llm.example.com {
    encode zstd gzip

    reverse_proxy 100.118.73.52:15722 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Nginx 配置

`/etc/nginx/sites-available/llm.example.com`：

```nginx
server {
    listen 80;
    server_name llm.example.com;

    location / {
        proxy_pass http://100.118.73.52:15722;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

启用并签 TLS：

```bash
sudo ln -s /etc/nginx/sites-available/llm.example.com /etc/nginx/sites-enabled/llm.example.com
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d llm.example.com
```

## 方案 B：中转机通过 SSH 反向隧道回连 CC Switch

适合不想安装 Tailscale，但 Windows 机器可以主动连到中转机的场景。
此方案中 CC Switch 监听必须保持 `127.0.0.1:15722`；不需要开放 Windows 入站端口。
在 Windows SSH 客户端验证并固定中转机 host key，禁止关闭 host-key 验证；
为隧道使用独立、最小权限的 SSH 身份，不要复制上游模型凭据到中转机。

在 Windows 机器上执行：

```powershell
ssh -N -R 127.0.0.1:15722:127.0.0.1:15722 user@relay.example.com
```

含义：

- 中转机本地 `127.0.0.1:15722`
- 会被转发到 Windows 机器本地 `127.0.0.1:15722`

然后在中转机上测试：

```bash
curl -i http://127.0.0.1:15722/health
```

Caddy 反代写成：

```caddyfile
llm.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:15722
}
```

Nginx 的 `proxy_pass` 写成：

```nginx
proxy_pass http://127.0.0.1:15722;
```

生产使用建议把 SSH 隧道做成 Windows 计划任务或服务，并启用自动重连工具，例如 `autossh`。

## 不采用公网明文端口转发

不要配置公网 `15722 -> Windows:15722`。当前监听器没有内置 TLS，
即使前面还有一个 HTTPS 中转域名，域名到 Windows 的公网 HTTP 一跳仍会暴露
请求内容和 `ccsw_...` 凭据。改用方案 A 的私有加密链路或方案 B 的 SSH 反向隧道。

同样不要发布接管端口 `15721`、CDP `9229`、Tauri IPC 或 Codex app-server。

## 域名 DNS

把域名解析到中转机公网 IP：

```text
llm.example.com A <中转机公网IPv4>
```

如果使用 Cloudflare 代理，先用“仅 DNS”模式验证通，再考虑打开代理。SSE 流式响应要求反代不要缓存，并且超时时间要足够长。

## 验证命令

健康检查：

```bash
curl -i https://llm.example.com/health
```

未带 Key 的模型列表应该返回认证错误：

```bash
curl -i https://llm.example.com/v1/models
```

带 Key 的模型列表：

```bash
curl -sS https://llm.example.com/v1/models \
  -H "Authorization: Bearer ccsw_xxx" | jq
```

Chat Completions 非流式：

```bash
curl -sS https://llm.example.com/v1/chat/completions \
  -H "Authorization: Bearer ccsw_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [
      { "role": "user", "content": "ping" }
    ]
  }' | jq
```

Chat Completions 流式：

```bash
curl -N https://llm.example.com/v1/chat/completions \
  -H "Authorization: Bearer ccsw_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "stream": true,
    "messages": [
      { "role": "user", "content": "ping" }
    ]
  }'
```

OpenAI Python SDK：

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm.example.com/v1",
    api_key="ccsw_xxx",
)

response = client.chat.completions.create(
    model="gpt-5.4-mini",
    messages=[{"role": "user", "content": "ping"}],
)

print(response.choices[0].message.content)
```

## 安全建议

- 不要把 `15722` 直接裸露到公网，优先放在 Tailscale、SSH 隧道或反代后面。
- `ccsw_...` Key 只保护模型 API endpoint，不能授权远程控制；仍要当作真实凭据保管。
- 当前可复制的多 Key 记录在设置数据库中保留明文，并非只有 hash；保护数据库、备份和同步副本，泄漏后撤销/轮换。
- 反代层可以额外加 IP allowlist、Basic Auth、mTLS 或 Cloudflare Access。
- 不要在 Caddy/Nginx 日志里记录完整 Authorization header。
- 不要把 CC Switch 的 OAuth token、refresh token、真实上游 API Key 复制到中转机。
- 如果面向公网，建议中转机只开放 `443`，不要开放 `15722`。

## 故障排查

按这条链路从近到远排查：

1. Windows 本机（SSH/loopback 方案；只绑定私有网卡时跳过此项）：

```powershell
curl.exe http://127.0.0.1:15722/health
```

2. Windows 私有网卡地址（mesh 方案；SSH/loopback 方案不开放此项）：

```powershell
curl.exe http://<Windows局域网IP>:15722/health
```

3. 中转机到 Windows 私有地址（mesh 方案）：

```bash
curl -i http://<Tailscale或内网IP>:15722/health
```

4. 中转机本地反代 upstream（SSH 方案）：

```bash
curl -i http://127.0.0.1:15722/health
```

5. 域名：

```bash
curl -i https://llm.example.com/health
```

常见现象：

- mesh 方案本机通、私有链路不通：检查选定私有网卡监听地址、mesh ACL 和 Windows 防火墙。SSH 方案无需开放 LAN 监听。
- 私有网卡通、中转机不通：检查 Tailscale ACL/SSH 隧道，不要改成公网明文端口转发。
- 中转机 upstream 通、域名不通：检查 DNS、Caddy/Nginx、TLS 证书和安全组。
- 非流式通、流式卡住：关闭反代缓存，增加 `proxy_read_timeout`，确认客户端支持 SSE。
