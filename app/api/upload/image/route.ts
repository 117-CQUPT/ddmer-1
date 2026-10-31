import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/app/lib/prisma";
import { getCurrentUser } from "@/app/lib/auth";
import { uploadFile, deleteFile, cleanUrlPath, generateFileName } from "@/app/lib/r2";

function ensureR2PublicUrl(): void {
  if (!process.env.R2_PUBLIC_URL) {
    throw new Error(
      "R2_PUBLIC_URL 未配置。请为 Cloudflare R2 存储桶设置自定义域（Public URL），否则上传的图片无法在前台公开访问。"
    );
  }
}

/**
 * 把 AWS SDK / Cloudflare R2 抛出的底层错误翻译成可以直接照做的提示。
 *
 * 背景：这里原先统一返回 `{ error: "上传失败" }`，导致线上只能看到 500，
 * 无法区分「凭证缺权限」「桶名写错」「密钥不对」等情况，排查成本极高。
 * R2 的错误码语义与 S3 一致：
 *   - AccessDenied          → 凭证有效但没有写权限（权限档位 / 桶范围 / IP 白名单）
 *   - NoSuchBucket          → R2_BUCKET_NAME 写错或桶不存在
 *   - InvalidAccessKeyId    → R2_ACCESS_KEY_ID 不存在
 *   - SignatureDoesNotMatch → R2_SECRET_ACCESS_KEY 不对
 */
function describeR2Error(err: any): { message: string; code?: string } {
  const code: string | undefined = err?.Code || err?.code || err?.name;

  const messages: Record<string, string> = {
    AccessDenied:
      "Cloudflare R2 拒绝写入（AccessDenied）。请依次检查：① API Token 权限是否为 Object Read & Write；② Token 的存储桶范围是否包含 R2_BUCKET_NAME；③ Token 是否设置了 IP 白名单（Vercel 出口 IP 是动态的，开启后必然被拒）。",
    NoSuchBucket:
      "R2 存储桶不存在（NoSuchBucket）。请检查环境变量 R2_BUCKET_NAME 是否与 Cloudflare 控制台中的桶名完全一致。",
    InvalidAccessKeyId:
      "R2 Access Key 无效（InvalidAccessKeyId）。请检查 R2_ACCESS_KEY_ID 是否正确，是否在 Cloudflare 后台被删除或重新生成。",
    SignatureDoesNotMatch:
      "R2 密钥不匹配（SignatureDoesNotMatch）。请检查 R2_SECRET_ACCESS_KEY 是否完整复制（注意首尾空格）。",
    InvalidBucketName:
      "R2 存储桶名称非法（InvalidBucketName）。桶名只能包含小写字母、数字和连字符。",
    RequestTimeTooSkewed:
      "请求时间与 R2 服务器偏差过大（RequestTimeTooSkewed）。请检查运行环境的系统时间。",
  };

  if (code && messages[code]) {
    return { message: messages[code], code };
  }

  const rawMessage: string = typeof err?.message === "string" ? err.message : "";

  if (rawMessage === "Missing R2 credentials") {
    return {
      message:
        "缺少 R2 凭证：请配置 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY 三个环境变量。",
      code: "MissingR2Credentials",
    };
  }

  if (rawMessage.includes("R2_PUBLIC_URL")) {
    return { message: rawMessage, code: "MissingR2PublicUrl" };
  }

  return { message: "上传失败", code };
}

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export async function POST(request: Request) {
  try {
    const payload = await getCurrentUser(request);
    const userId = parseInt(payload.sub as string);
    if (isNaN(userId)) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.is_admin) {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "缺少文件" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "不支持的文件类型" }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: "文件大小超过 10MB 限制" }, { status: 400 });
    }

    const ext = file.type === "image/svg+xml" ? "svg" : file.type.split("/")[1];
    const filename = generateFileName(ext);
    const key = `uploads/${filename}`;

    const buffer = await file.arrayBuffer();

    // 上传前必须配置 R2 公开访问域名，否则图片无法在前台显示
    ensureR2PublicUrl();

    // 简易方向检测（Cloudflare 不支持 sharp 原生模块）
    let orientation = "landscape";
    // 后续可通过 Cloudflare Images 的 metadata 获取，这里默认 landscape

    const imageUrl = await uploadFile(key, buffer, file.type);

    return NextResponse.json({
      url: imageUrl,
      orientation,
    });
  } catch (err: any) {
    if (err?.message === "未登录" || err?.message === "无效的令牌") {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }

    // 完整错误留在服务端日志里（Vercel → Logs 可查）
    console.error("Upload image error:", err);

    const { message, code } = describeR2Error(err);
    return NextResponse.json({ error: message, code }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const payload = await getCurrentUser(request);
    const userId = parseInt(payload.sub as string);
    if (isNaN(userId)) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.is_admin) {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const url = searchParams.get("url");
    if (!url) {
      return NextResponse.json({ error: "缺少 url 参数" }, { status: 400 });
    }

    const key = cleanUrlPath(url);
    if (key.includes("..") || key.includes("\\")) {
      return NextResponse.json({ error: "非法文件名" }, { status: 400 });
    }

    await deleteFile(key);
    return NextResponse.json({ code: 0, message: "删除成功" });
  } catch (err: any) {
    console.error("Delete image error:", err);
    return NextResponse.json({ error: err.message || "删除失败" }, { status: 500 });
  }
}
