#!/usr/bin/env node
/**
 * Cloudflare R2 连通性 / 写权限自检
 *
 * 用途：当后台上传图片报 500 时，用它区分到底是
 *   ① 凭证缺失  ② Access Key 无效  ③ Secret 错误
 *   ④ 桶名写错  ⑤ 有凭证但没写权限  ⑥ Public URL 没配
 *
 * 用法（在项目根目录执行）：
 *   node --env-file=.env.local scripts/check-r2.mjs
 *   或
 *   node --env-file=.env scripts/check-r2.mjs
 *
 * 它会真实发起一次 PutObject，写入 uploads/_selfcheck-<时间>.txt，
 * 成功后立刻删除，不在桶里留下垃圾文件。
 */

import { randomUUID } from "node:crypto";

const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import(
  "@aws-sdk/client-s3"
).catch((e) => {
  console.error("❌ 无法加载 @aws-sdk/client-s3");
  console.error("   请先在项目根目录安装依赖：pnpm install（或 npm install）");
  console.error("   原始错误：" + (e?.message || e));
  process.exit(1);
});

const REQUIRED = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);

if (missing.length > 0) {
  console.error("❌ 缺少环境变量：" + missing.join(", "));
  console.error(
    "   请确认你用的是正确的 env 文件，例如：node --env-file=.env.local scripts/check-r2.mjs"
  );
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET_NAME || "kirameku-files";
const publicUrl = process.env.R2_PUBLIC_URL;
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const key = `uploads/_selfcheck-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;

const mask = (v) => (v ? `${v.slice(0, 6)}…(${v.length} 字符)` : "(空)");

console.log("=== R2 配置 ===");
console.log("Endpoint     :", endpoint);
console.log("Bucket       :", bucket);
console.log("AccessKeyId  :", mask(process.env.R2_ACCESS_KEY_ID));
console.log("SecretKey    :", mask(process.env.R2_SECRET_ACCESS_KEY));
console.log("PublicURL    :", publicUrl || "⚠️  未配置（上传能成功，但前台图片会打不开）");
console.log("");

const client = new S3Client({
  region: "auto",
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const ADVICE = {
  AccessDenied: [
    "凭证有效，但这个 Token 没有写入权限。请到 Cloudflare → R2 → Manage R2 API Tokens 检查：",
    "  1. Permission 是否为 Object Read & Write（选了 Read only 就会这样）",
    "  2. 是否限定到某个桶，且该桶名等于上面的 Bucket",
    "  3. 是否设置了 Client IP Address Filtering —— Vercel 出口 IP 是动态的，开了必然被拒",
    "  4. Token 是否已过期",
  ],
  NoSuchBucket: [
    "桶不存在。请核对 Cloudflare 控制台里的桶名与环境变量 R2_BUCKET_NAME 是否完全一致（区分大小写）。",
  ],
  InvalidAccessKeyId: [
    "Access Key 不存在。可能在 Cloudflare 后台被删除或重新生成过，请重新创建 Token 并更新环境变量。",
  ],
  SignatureDoesNotMatch: [
    "Secret 不正确。注意复制时是否带了首尾空格，或只复制了一半。",
  ],
  InvalidBucketName: [
    "桶名非法。R2 桶名只能包含小写字母、数字和连字符。",
  ],
};

try {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: "dsh connectivity check",
      ContentType: "text/plain",
    })
  );
  console.log("✅ PutObject 成功");

  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    console.log("✅ 测试对象已清理");
  } catch (e) {
    console.warn("⚠️  测试对象清理失败（不影响结论）：", e?.Code || e?.name);
  }

  console.log("");
  console.log("=== 结论 ===");
  console.log("R2 凭证与写权限正常。");
  if (!publicUrl) {
    console.log("但 R2_PUBLIC_URL 未配置，上传接口会直接报错，前台也显示不了图片。");
  }
  console.log("");
  console.log("如果 Vercel 线上仍报 AccessDenied，说明线上环境变量与本地不一致：");
  console.log("  1. 逐个比对 Vercel → Settings → Environment Variables 里的 4 个 R2 值");
  console.log("  2. 修改环境变量后必须 Redeploy 才会生效");
} catch (e) {
  const code = e?.Code || e?.name || "Unknown";
  console.error(`❌ PutObject 失败 [${code}]`);
  console.error("Message :", e?.message);
  console.error("Endpoint:", endpoint);
  console.error("Bucket  :", bucket);
  console.error("");

  const tips = ADVICE[code];
  if (tips) {
    console.error("=== 处理建议 ===");
    for (const line of tips) console.error(line);
  } else {
    console.error("=== 处理建议 ===");
    console.error("未识别的错误码，请把上面的 Code 和 Message 完整保留。");
  }
  process.exit(1);
}
