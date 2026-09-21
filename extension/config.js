// Supabase 连接配置。
//
// ⚠️ 关于这里的 anon key：它**不是密钥，是公开的**——
// 它已经随网页构建产物发布在线上，任何人都能从 bundle 里抠出来。
// 项目的安全边界从来不靠它，而是靠数据库的 RLS 策略（见 docs/SECURITY.md）。
//
// 🔴 绝对不要把 service_role key 放进这里。它是唯一能绕过全部 RLS 的钥匙，
//    放进扩展就等于把所有私聊和动态交给任何能读到这个文件的人。
//    这条与 AGENTS.md 的硬约束第 1 条一致。

export const SUPABASE_URL = 'https://pshscdqhhsktrpzkbmei.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzaHNjZHFoaHNrdHJwemtibWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMDQ2MjQsImV4cCI6MjEwMjg4MDYyNH0.wVVzYiu1pnth1fsBaz0dNJ9QTj47rHKCJOA9zjboc_o'
