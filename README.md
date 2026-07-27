# FXAP Decryptor

独立的 FiveM FXAP 资源解密工具。CFX server key 是可选参数：有 key 时先使用官方 Keymaster；缺少目标 `grants_clk` 时，通过 Bearer 鉴权从 Cloudflare Workers KV 查询。客户端最终 key 与 dump-tool 一样由 Cloudflare `/v1/derive` 返回，仓库不包含当前真实派生公式。

## 使用

要求 Node.js 18 或更高版本。Lua 反编译需要 Java 8 或更高版本，仓库不内置 Java。

不提供 CFX key：

```powershell
node . "D:\server\resources\my_resource"
node . "D:\server\resources" "C:\Program Files\Java\jdk-21"
```

优先使用 CFX Keymaster，缺失时回退 Cloudflare：

```powershell
node . "cfxk_xxxxxxxxx" "D:\server\resources" "C:\Program Files\Java\jdk-21"
```

目录参数可以是直接包含 `.fxap` 的单个 resource，也可以是包含多个 resource 的父目录。输出自动写到输入目录旁边的 `<原目录名>_decrypted`。

## Cloudflare fallback

复制 `.env.example` 为不会提交 Git 的 `.env`，填写 Bearer Token：

```dotenv
CK_GRANTS_CLK_API_URL=https://grantsclk.ckcloud.de5.net
CK_GRANTS_CLK_API_TOKEN=replace-with-your-bearer-token
```

也可以使用同名系统环境变量。只有本地缺少目标 resource ID 的 `grants_clk` 时，才调用带 Bearer 鉴权的 KV 查询接口。Bearer Token 只由 `fxap_only` 自身读取，CK 免费工具箱不提供、不保存也不传入该 Token：

```http
GET /v1/grants-clk/:resourceId
Authorization: Bearer <token>
```

拿到 `grants_clk` 后，无论它来自 Keymaster 还是 Cloudflare KV，客户端最终 key 都按 dump-tool 的协议请求：

```http
POST /v1/derive
Content-Type: application/json

{"resourceId":"7033","grants_clk":"<96位十六进制>"}
```

`fxap_only` 不实现当前真实客户端派生公式，只校验 Cloudflare 返回的 32 字节 key。Cloudflare 不存在上传接口；CFX key、Bearer Token 和 grants 数据都不会写入 Git。

服务端文件仍直接使用 Keymaster `grants`。只有 `grants_clk` 而没有 `grants` 时，可解开使用客户端派生 key 的文件，但无法替代服务端独立的 `grants` key。

## 处理内容

- 解开标准 FXAP 文件并保留目录结构；
- 复制未加密文件；
- 使用 Java `unluac54.jar` 反编译 Lua 5.4 字节码；
- 找不到 Java 或反编译失败时保留 `.luac`，可反汇编时同时保留 `.asm`；
- 保留标准 RSC stream 解密路径；
- 不包含 `decrypt-eup-stream.js` 的无 `.fxap` EUP 推断、worker 池或固定 `ok` 目录。

## 退出码

- `0`：全部成功；
- `1`：至少一个 resource 整体失败；
- `2`：resource 已处理，但至少一个文件解密失败。

## CK 免费工具箱组件 Release

本仓库按 `component-manifest.json` 发布给 CK 免费工具箱。Release ZIP 只有一个顶层目录，附件名与工具箱登记规则一致：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Build-Release.ps1
```

默认生成 `dist/fxap-only-v1.1.1-windows.zip` 和 `dist/fxap-only-v1.1.1-windows.zip.sha256`。ZIP 包含运行源码和 `tools/unluac54.jar`，不包含 `.env`、Node.js、Java、Git 元数据、测试输出或真实密钥。Node.js 18+ 与 Java 仍由用户外部安装；Cloudflare 鉴权继续封装在 `fxap_only` 内部。

推送到 main 后，GitHub Actions 会在 Node.js 18/22 上测试，通过后按 VERSION 的主/次版本和本 workflow 的递增运行编号自动创建稳定 tag 与正式 Release；手工推送稳定 vSemVer tag 时则按该 tag 发布。每个正式 Release 都同时上传 ZIP 和 SHA-256，CK 免费工具箱无需内置该组件，会直接检查并安装最新稳定 Release。

## 验证

```powershell
npm.cmd test
```

工具没有 npm 运行时依赖。`unluac54.jar` 的许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
