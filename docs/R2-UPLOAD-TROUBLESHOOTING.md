# 图片上传失败（500）排查指南

后台「站点配置 → 更换头像」或任何图片上传报 500 时，按本文定位。

上传链路：

```
浏览器 el-upload
  → POST /api/upload/image  (Bearer token)
  → app/api/upload/image/route.ts   鉴权 + 类型/大小校验
  → app/lib/r2.ts  uploadFile()     PutObjectCommand
  → Cloudflare R2
  → 返回 { url: "<R2_PUBLIC_URL>/uploads/xxx.png" }
```

任何一环失败都会变成 500。改造后接口会同时返回 `code` 字段，直接告诉你是哪一环。

## 一、先看 `code` 字段

`POST /api/upload/image` 失败时响应体形如：

```json
{ "error": "Cloudflare R2 拒绝写入（AccessDenied）……", "code": "AccessDenied" }
```

| code | 含义 | 处理 |
| --- | --- | --- |
| `AccessDenied` | 凭证有效，但没有写入权限 | 见下方「二」 |
| `NoSuchBucket` | 桶名写错或桶不存在 | 核对 `R2_BUCKET_NAME` |
| `InvalidAccessKeyId` | Access Key 不存在 | 重新生成 Token |
| `SignatureDoesNotMatch` | Secret 不正确 | 重新复制，注意首尾空格 |
| `MissingR2Credentials` | 三个凭证变量缺一 | 补齐环境变量 |
| `MissingR2PublicUrl` | `R2_PUBLIC_URL` 未配置 | 给桶配自定义域，或填 `https://<account>.r2.cloudflarestorage.com` 的公开地址 |

## 二、`AccessDenied` 的四种可能

Cloudflare R2 的 `AccessDenied` 只说明「这个凭证不能写这个桶」，常见原因按概率排序：

1. **Token 权限档位选错**
   创建 R2 API Token 时选成了 `Object Read only`。
   → 需要 `Object Read & Write`。

2. **Token 限定了桶，但不包含目标桶**
   创建时选了「Specify bucket」，但桶名与 `R2_BUCKET_NAME` 不一致，或目标桶是在 Token 之后才创建的。
   → 重建 Token，桶范围选 `kirameku-files`（或 All buckets）。

3. **Token 开了 IP 白名单**
   `Client IP Address Filtering` 一旦开启，只允许白名单 IP。
   **Vercel 的出口 IP 是动态的**，线上必然被拒，而本地一切正常。
   → 关闭 IP 过滤。

4. **Account ID 与 Token 不属于同一账号**
   注意别把 **Zone ID** 当成 **Account ID**。Account ID 在 R2 概览页右侧，32 位十六进制。

## 三、用自检脚本一次定位

```bash
# 在项目根目录
node --env-file=.env.local scripts/check-r2.mjs
```

脚本会真实执行一次 `PutObject` 再删除，输出具体的 `Code`，并给出对应建议。

判断方法：

- **本地成功、线上失败** → 一定是 Vercel 环境变量与本地不一致（漏配 / 旧 Token / 拼写错误）。改完变量**必须 Redeploy**。
- **本地也失败** → Token 本身没有写权限，按「二」处理。

## 四、修复后验证

1. 在 Vercel → Settings → Environment Variables 确认这四项：

   ```
   R2_ACCOUNT_ID
   R2_ACCESS_KEY_ID
   R2_SECRET_ACCESS_KEY
   R2_BUCKET_NAME
   R2_PUBLIC_URL
   ```

2. 修改环境变量后执行 **Redeploy**（不是 Restart）。
3. 后台上传一张小图，浏览器 Network 里 `/api/upload/image` 应返回 200，body 含 `url`。
4. 确认该 `url` 能在无痕窗口直接打开（验证 `R2_PUBLIC_URL` 配置正确、桶允许公开读）。

## 五、其他注意事项

- `R2_PUBLIC_URL` 必须是**公开可读**的地址。`https://<account>.r2.cloudflarestorage.com/<bucket>` 是 S3 私有端点，浏览器直接访问会 401/403，不能拿来当 Public URL，除非该桶开启了 Public Access 并绑定了 `r2.dev` 或自定义域。
- Vercel Serverless 的请求体上限约 4.5MB，超过会在到达代码前返回 413。当前接口限制 10MB，但线上实际受 4.5MB 约束。
- 上传走的 Authorization 是 `Bearer <accessToken>`，Token 过期会返回 401，与 R2 无关。
