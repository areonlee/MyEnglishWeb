-- =============================================================================
-- 邀请奖励防并发重复：同一用户只能有一条「新用户邀请奖励」流水
-- 复制到 Supabase SQL Editor 后点 Run（本文件不由助手代为执行）
-- 项目: wxgrcbdzccjtveuostus
--
-- 不修改：process_referral_bonus 函数体、前端、邀请金额/规则
-- 只增加数据库约束
--
-- 若下方查重查询有行，先人工处理重复流水，再执行唯一索引，否则 CREATE 会失败
-- =============================================================================

-- 1) 执行前检查：同一 user_id 是否已有多条邀请 +20
select user_id, count(*)
from public.point_logs
where reason = '新用户邀请奖励'
group by user_id
having count(*) > 1;

-- 2) 部分唯一索引：每个用户最多一条「新用户邀请奖励」
create unique index if not exists point_logs_invitee_bonus_uidx
  on public.point_logs (user_id)
  where reason = '新用户邀请奖励';

-- 3) 确认索引已存在
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'point_logs'
  and indexname = 'point_logs_invitee_bonus_uidx';
