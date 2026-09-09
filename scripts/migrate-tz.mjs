/**
 * Phase 7.5 存量迁移：为无 timezone 的 CalendarDraft/CalendarWrite 回填时区标记。
 *
 * 语义说明：Phase 7 存量 proposedStart/End 在写入时按"服务器本地墙钟 → Prisma DateTime"
 * 转换为 Instant，存储值本身合法且不变；本脚本仅回填 timezone 列 = LIFEOS_LEGACY_TZ
 * （默认 Asia/Shanghai，即当时的开发服务器时区），绝不把任何墙钟字符串重新解释为 UTC。
 *
 * 用法：node scripts/migrate-tz.mjs [legacyTz]
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const legacyTz = process.argv[2] || process.env.LIFEOS_LEGACY_TZ || "Asia/Shanghai";

async function main() {
  const drafts = await prisma.calendarDraft.updateMany({
    where: { timezone: null },
    data: { timezone: legacyTz },
  });
  const writes = await prisma.calendarWrite.updateMany({
    where: { timezone: null },
    data: { timezone: legacyTz },
  });
  console.log(`迁移完成：CalendarDraft ${drafts.count} 条、CalendarWrite ${writes.count} 条 → timezone=${legacyTz}（存储 Instant 不变）`);
}

main().finally(() => prisma.$disconnect());
