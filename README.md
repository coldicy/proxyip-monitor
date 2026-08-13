
#### ⚙️ ip.txt

```text
# 支持 ip:port / 域名:port / 裸ip(默认443) / 裸域名(默认443) / [IPv6]:port
38.22.93.183:443
43.154.124.136:26666
cdn.2x.nz
149.104.8.95:23333
[2606:4700::1]:443
```

#### 🚀 部署步骤

```
mkdir -p proxy-monitor/config proxy-monitor/public
cd proxy-monitor
# 把上面 4 个文件放好（server.js、public/index.html、Dockerfile、docker-compose.yml）
# 编辑 config/ip.txt 和 docker-compose.yml 的环境变量
docker compose up -d --build
# 打开 http://你的iStoreOS_IP:8787
```