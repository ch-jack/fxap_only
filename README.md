# FXAP Decryptor

用于解密已获授权的 FiveM FXAP 资源。CFX Key 是可选参数：提供 Key 时先通过官方 Cfx.re Keymaster 校验并读取 grants；没有 Key、Key 校验失败，或当前 resource 的密钥数据不完整时，工具会按 resource ID 查询 Keymaster grants API。

客户端密钥仍按 dump-tool 的方式由 Cloudflare `/v1/derive` 返回，真实派生算法不写入本仓库。Cloudflare 不再负责存储或查询 `grants` / `grants_clk`。

## 运行要求

- Node.js 18 或更高版本；
- Java 仅用于反编译 Lua 5.4 字节码，可不安装；
- 仓库和 Release 均不内置 Node.js 或 Java；
- 可将 Java/JDK 目录作为命令行参数传入。

## 使用

不提供 CFX Key：

```powershell
node . "D:\server\resources\my_resource"
node . "D:\server\resources" "C:\Program Files\Java\jdk-21"
```

提供 CFX Key：

```powershell
node . "cfxk_xxxxxxxxx" "D:\server\resources" "C:\Program Files\Java\jdk-21"
```

兼容旧参数顺序：

```powershell
node . "D:\server\resources" "cfxk_xxxxxxxxx"
```

目录参数可以是直接包含 `.fxap` 的单个 resource，也可以是包含多个 resource 的父目录。输出自动写入输入目录旁边的 `<原目录名>_decrypted`。

## 密钥请求流程

1. 提供 CFX Key 时，先向官方 Keymaster 请求 grants。只有官方校验成功后，才调用 `POST /v1/keymaster/import` 将该 Key 导入 grants API。
2. 读取每个 `.fxap` 中的 resource ID。若本地缺少该 ID 的 `grants` 或 `grants_clk`，调用 `GET /v1/resources/:resourceId`，一次取得这两个字段。
3. 存在 `grants_clk` 时，调用 Cloudflare `POST /v1/derive` 取得 32 字节客户端密钥。仓库不包含真实派生公式。
4. grants API 查询失败但本地已有可用密钥时会警告并继续；完全没有密钥材料时，该 resource 会报告失败。

grants API 的默认地址和公开客户端 Bearer Token 已封装在 `fxap_only` 中，用户无需创建 `.env`，CK 免费工具箱也不提供或传入 Token。当前默认 grants API 使用 HTTP，因此提交的 CFX Key 和 Bearer Token 会以明文经过网络；这是当前部署方式的既定行为。

需要切换部署时，可通过 `.env` 或系统环境变量覆盖：

```dotenv
CK_KEYMASTER_GRANTS_API_URL=http://127.0.0.1:3000
CK_KEYMASTER_GRANTS_API_TOKEN=replace-with-an-alternate-bearer-token
CK_CLIENT_KEY_API_URL=https://grantsclk.ckcloud.de5.net
```

## 处理内容

- 解开标准 FXAP 文件并保留目录结构；
- 复制未加密文件；
- 解密服务端 `grants` 文件和客户端派生密钥文件；
- 使用外部 Java 和 `tools/unluac54.jar` 反编译 Lua 5.4 字节码；
- 找不到 Java 或反编译失败时保留 `.luac`，可反汇编时同时保留 `.asm`；
- 保留标准 RSC stream 解密路径；
- 不包含 `decrypt-eup-stream.js` 的无 `.fxap` EUP 推断、Worker 池或固定 `ok` 目录功能。

## 退出码

- `0`：全部成功；
- `1`：至少一个 resource 整体失败；
- `2`：resource 已处理，但至少一个文件解密失败。

## CK 免费工具箱组件 Release

本仓库按 `component-manifest.json` 发布给 CK 免费工具箱。工具箱不会内置该组件，而是从 GitHub 最新正式 Release 按需下载并校验 SHA-256。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Build-Release.ps1
```

`v1.2.0` 默认生成：

- `dist/fxap-only-v1.2.0-windows.zip`
- `dist/fxap-only-v1.2.0-windows.zip.sha256`

ZIP 包含运行源码和 `tools/unluac54.jar`，不包含 `.env`、Node.js、Java、Git 元数据或测试输出。推送到 `main` 后，GitHub Actions 会在 Node.js 18/22 上测试、构建并发布稳定 Release。

## 验证

```powershell
npm.cmd test
```

工具没有 npm 运行时依赖。`unluac54.jar` 的许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
