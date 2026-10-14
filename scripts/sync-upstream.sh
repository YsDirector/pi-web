#!/usr/bin/env bash
# ============================================================================
# sync-upstream.sh — 把上游 agegr/pi-web 的新版本合并进 fork，尽量自动化。
#
# 用法：
#   ./scripts/sync-upstream.sh          # fetch + merge + build + test
#   ./scripts/sync-upstream.sh --push   # 合并验证通过后提交并推送 origin
#
# 工作原理：
#   1. 工作区必须干净（有未提交改动会拒绝，先 commit/stash）。
#   2. git fetch upstream && git merge upstream/main。
#   3. 已知冲突自动处理：
#      - package.json / package-lock.json → 取上游版本（版本号跟随上游，next 再回钉）。
#      - public/sw.js → 默认取 fork 版本。fork 改写了上游的缓存策略（static 资源用
#        networkFirst 取代 cacheFirst，导航加离线 shell 回放，另有会话数据缓存），
#        但两者共有的超时兜底（fetchWithTimeout / NAVIGATION_TIMEOUT_MS /
#        ASSET_TIMEOUT_MS）一致。脚本先做一次守卫：只比较上游**新引入**的顶层标识符
#        （= 上游声明 ∖ (fork HEAD ∪ merge-base)）；命中则**放弃自动化**、留冲突给人工，
#        避免上游将来新增的 sw 修复被静默丢掉。
#      - 其余文件依赖 git rerere：首次合并需手工解决，此后 rerere 自动套用记忆的解法。
#      - ChatInput.tsx 不再有 fork 专属的 slash-command 逻辑，跟随上游版本即可。
#   4. next 固定在 16.2.12（16.3.1 在 Node 26 上 SIGBUS 崩溃，见 73db307）。
#   5. npm install --include=dev（install-scripts 被阻止的包需 approve）。
#   6. 构建 + 全量测试，通过后提示提交。
#
# fork 独有功能（合并时保留）：
#   - bash-bg 后台任务回执卡片
#   - ExtensionDialog secret 密码输入、超时倒计时、代码块高亮
#   - 离线 shell/会话缓存与永不黑屏的 PWA fallback
#   - 备份：backup/custom-features-v0.8.8 分支 + ~/.pi/agent/patches/pi-web-custom-backup/
# ============================================================================

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PUSH="${1:-}"

# 0) 前置检查
# 合并进行中（MERGE_HEAD 存在）时允许工作区“脏”：那正是“冲突已解决、准备续跑验证”
# 的状态。脚本原先无条件拒绝脏工作区，导致它自己打印的
# “解决后 git add 这些文件，再运行 $0 继续”根本无法执行。
MERGE_IN_PROGRESS=0
if [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
  MERGE_IN_PROGRESS=1
fi
if [ "$MERGE_IN_PROGRESS" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区不干净，请先提交或 stash："
  git status --short | head -20
  exit 1
fi
if ! git remote | grep -q '^upstream$'; then
  echo "✗ 缺少 upstream remote（git remote add upstream git@github.com:agegr/pi-web.git）"
  exit 1
fi
# rerere 必须无条件打开。旧写法是
#   git config rerere.enabled >/dev/null 2>&1 || git config rerere.enabled true
# 但 .git/config 里若已存在显式的 rerere.enabled=false，`git config` 仍返回退出码 0，
# `||` 分支永远不会执行——rerere 于是长期处于关闭状态，冲突从不被记忆。
git config rerere.enabled true

# 1) fetch + merge
if [ "$MERGE_IN_PROGRESS" = 1 ]; then
  echo "=== [1-2/6] 检测到进行中的合并（MERGE_HEAD），跳过 fetch/merge，直接续跑验证 ==="
  UPSTREAM_HEAD=$(git rev-parse --short upstream/main)
  FORK_HEAD=$(git rev-parse --short main)
  echo "upstream: $UPSTREAM_HEAD / fork: $FORK_HEAD"
else
  echo "=== [1/6] fetch upstream ==="
  git fetch upstream
  UPSTREAM_HEAD=$(git rev-parse --short upstream/main)
  FORK_HEAD=$(git rev-parse --short main)
  echo "upstream: $UPSTREAM_HEAD / fork: $FORK_HEAD"
  if git merge-base --is-ancestor upstream/main main; then
    echo "✓ 本地已包含 upstream/main，无需合并"
    exit 0
  fi

  echo "=== [2/6] merge upstream/main ==="
  git merge upstream/main --no-edit || true
fi

# 2.5) 已知冲突自动处理
echo "=== [2.5/6] 处理已知冲突 ==="
for f in package.json package-lock.json; do
  if [ -f "$f" ] && grep -q "^<<<<<<<" "$f"; then
    echo "  $f → 取上游版本"
    git checkout --theirs "$f"
    git add "$f"
  fi
done

# public/sw.js：fork 版本把上游的缓存策略改写过（static 资源用 networkFirst 取代
# cacheFirst，导航加离线 shell 回放，另有会话数据缓存），所以不能简单说“取 ours”。
# 守卫规则：只比较上游**新引入**的顶层标识符，即 (上游声明) ∖ (fork HEAD ∪ merge-base)。
# fork 有意删掉的 cacheFirst 在 merge-base 里已存在，会被正确排除；而一旦上游将来真
# 新增一个 sw 函数/常量，守卫就会命中并放弃自动化，把冲突留给人工——不会静默丢掉上游的修复。
if [ -f public/sw.js ] && grep -q "^<<<<<<<" public/sw.js; then
  SW_DECLS() {
    grep -oE '^(async )?function [A-Za-z0-9_]+|^const [A-Za-z0-9_]+' "$1" \
      | sed -E 's/^(async )?function //; s/^const //' | sort -u
  }
  SW_TMP=$(mktemp -d)
  git show ":2:public/sw.js" >"$SW_TMP/ours.js"
  git show ":3:public/sw.js" >"$SW_TMP/theirs.js"
  SW_BASE_COMMIT=$(git merge-base HEAD MERGE_HEAD 2>/dev/null || true)
  if [ -n "$SW_BASE_COMMIT" ] && git cat-file -e "$SW_BASE_COMMIT:public/sw.js" 2>/dev/null; then
    git show "$SW_BASE_COMMIT:public/sw.js" >"$SW_TMP/base.js"
  else
    : >"$SW_TMP/base.js"
  fi
  SW_NEW_DECLS=$(comm -13 \
    <(cat <(SW_DECLS "$SW_TMP/ours.js") <(SW_DECLS "$SW_TMP/base.js") | sort -u) \
    <(SW_DECLS "$SW_TMP/theirs.js"))
  rm -rf "$SW_TMP"
  if [ -n "$SW_NEW_DECLS" ]; then
    echo "  ⚠ 上游 public/sw.js 新引入了 fork 版本没有的顶层标识符，放弃自动处理："
    echo "$SW_NEW_DECLS" | sed 's/^/      /'
    echo "    请人工确认上游新增的 sw 特性，并入 fork 的离线 shell/数据缓存版本。"
  else
    echo "  public/sw.js → 取 fork 版本（上游无新增顶层标识符）"
    git checkout --ours public/sw.js
    git add public/sw.js
  fi
fi

REMAINING=$(git diff --name-only --diff-filter=U || true)
if [ -n "$REMAINING" ]; then
  echo "⚠  剩余冲突需要手工解决（rerere 会自动套用已记忆解法）："
  echo "$REMAINING"
  cat <<'GUIDE'
  已知解法（v0.10.0 基线；完整预案见 ~/dev/pi-web-v0.10.0-merge-plan.md §2）：
    components/ChatWindow.tsx
        import 取上游 phaseLabel，追加 fork 的 splitDialogTitle / renderDialogTitle（删 AgentPhase）
        ExtensionWaitingCount 取上游（新功能 “+N more”）
        对话框 header 容器取上游（flexShrink:1 / minHeight:0 / maxHeight:"50vh"），
        标题保留 fork 的 {titleHead}，补 whiteSpace:"pre-wrap" / overflowWrap:"anywhere"
    components/MessageView.tsx
        import 取并集：fork 的 BACKGROUND_JOB_CUSTOM_TYPE
        + 上游的 apply-patch / tool-call-expansion / hasAssistantAnswer / isAssistantTruncated
    hooks/useAgentSession.ts
        action 联合类型取上游的 openSessionStats | openSettings
        通知抑制分支取上游的 `else if (!result.action)`
    lib/message-display.ts
        三个 customType 条件取并集；必须保留
        `message.customType === "compaction" || message.customType === BACKGROUND_JOB_CUSTOM_TYPE`
        那一行的原有单行写法——components/BackgroundJobMessage.test.mjs 用源码正则断言它
    public/sw.test.mjs
        保留 fork 的 shell/会话缓存测试；static 资源继续使用 fork 的 networkFirst，
        不直接套用上游 cacheFirst 测试
  解决后 git add 这些文件，再运行 $0 继续
GUIDE
  exit 1
fi

# 3) 依赖 + 版本固定
echo "=== [3/6] 依赖安装（next 固定 16.2.12，Node 26 SIGBUS 规避）==="
# 记录安装前的 next 版本：版本变化时必须丢弃 .next，否则陈旧生成物会毒害后续步骤
PREV_NEXT=$(node -p "require('./node_modules/next/package.json').version" 2>/dev/null || echo none)
# 确保 next 版本固定，避免 install 升级回 16.3.1
# 注意：上游 package.json 用精确版本（"16.3.1"），fork 曾经用 caret 范围（"^16.3.1"），
# 两种形态都要能改写——旧正则只匹配 caret 形式，升级后会静默失效导致 SIGBUS 复发。
grep -q '"next": "16.2.12"' package.json || sed -i -E 's/("next":[[:space:]]*)"[~^]?[0-9][0-9.]*"/\1"16.2.12"/' package.json
grep -q '"next": "16.2.12"' package.json || { echo "✗ next 固定 16.2.12 失败，检查 package.json"; exit 1; }
timeout 600 npm install --no-audit --no-fund --include=dev || {
  echo "  npm install 后 install-scripts 被阻止的包：npm install-scripts ls / approve"
  exit 1
}
# npm 11 拦截 install-scripts：批准已知安全包并重建 node-pty（无 Linux 预编译，
# 需系统 /usr/bin/node-gyp；已编译过则幂等秒过）
npm install-scripts approve node-pty sharp esbuild protobufjs 2>/dev/null || true
PATH="/usr/bin:$PATH" npm rebuild node-pty 2>/dev/null || true
node -e "require('node-pty')" 2>/dev/null || { echo "✗ node-pty 原生模块不可用"; exit 1; }
# jiti 偶发丢失（install 覆盖），确保存在
[ -d node_modules/jiti ] || npm install jiti --no-audit --no-fund --include=dev

# 4) 类型检查
# tsconfig 的 include 含 .next/types/**/*.ts，而这些是 next build 生成的。版本变化后
# 旧类型会引用新版本才有的导出（如 16.3.1 的 Prefetch）→ tsc 报几十条假错误。
# 只删生成物、保留 .next/cache 构建缓存。
NEW_NEXT=$(node -p "require('./node_modules/next/package.json').version")
if [ "$PREV_NEXT" != "$NEW_NEXT" ]; then
  echo "  next 版本变化（$PREV_NEXT → $NEW_NEXT）：丢弃陈旧的 .next 生成物"
  rm -rf .next
fi
rm -rf .next/types .next/dev/types

echo "=== [4/6] tsc --noEmit ==="
npx tsc --noEmit || { echo "✗ 类型错误"; exit 1; }

# 5) 构建（next 16.2.12；unset TURBOPACK —— 桌面环境该变量与 --webpack 冲突会静默退出）
echo "=== [5/6] next build --webpack ==="
timeout 600 env -u TURBOPACK npx next build --webpack || { echo "✗ 构建失败"; exit 1; }

# 6) 测试
echo "=== [6/6] 全量测试 ==="
timeout 600 npm test || { echo "✗ 测试失败"; exit 1; }

echo ""
echo "✓ 合并验证全部通过：upstream $UPSTREAM_HEAD → fork $FORK_HEAD"

# 7) 可选部署：./sync-upstream.sh [--push] --deploy
#    备份只留最近 1 份（避免 .next.old-* 攒出 10GB+）
if [ "${2:-}" = "--deploy" ]; then
  DEPLOY_DIR="$HOME/.npm-global/lib/node_modules/@agegr/pi-web"
  TS=$(date +%Y%m%d-%H%M%S)
  echo "=== [7/7] 部署到 $DEPLOY_DIR ==="
  mv "$DEPLOY_DIR/.next" "$DEPLOY_DIR/.next.old-$TS"
  rsync -a --exclude cache .next/ "$DEPLOY_DIR/.next/"
  rsync -a package.json package-lock.json next.config.ts "$DEPLOY_DIR/"
  rsync -a --delete public/ "$DEPLOY_DIR/public/"
  mv "$DEPLOY_DIR/node_modules" "$DEPLOY_DIR/node_modules.old-$TS"
  rsync -a --delete node_modules/ "$DEPLOY_DIR/node_modules/"
  # 内嵌宿主 secret 透传补丁（npm 原版覆盖 node_modules 后必须重打，否则密码框静默变明文）
  PI_WEB_ROOT="$DEPLOY_DIR" ~/.pi/agent/patches/pi-web-secret-input/apply.sh 2>&1 | tail -2 || echo "⚠ secret 补丁失败，检查 ~/.pi/agent/patches/pi-web-secret-input/"
  # 备份只留最近 1 份
  ls -dt "$DEPLOY_DIR"/.next.old-* 2>/dev/null | tail -n +2 | xargs -r rm -rf
  ls -dt "$DEPLOY_DIR"/node_modules.old-* 2>/dev/null | tail -n +2 | xargs -r rm -rf
  systemctl --user restart pi-web
  sleep 5
  if curl -sf -o /dev/null http://127.0.0.1:30141/; then
    echo "✓ 部署完成，服务健康：http://127.0.0.1:30141（旧备份保留一份：.next.old-$TS）"
  else
    echo "✗ 服务未响应，请检查：systemctl --user status pi-web"
    exit 1
  fi
fi

if [ "$PUSH" = "--push" ]; then
  git add -A
  git commit -m "Merge upstream main (v$(node -p "require('./package.json').version") | upstream $UPSTREAM_HEAD) into fork" || true
  git push origin main
  echo "✓ 已提交并推送到 origin/main"
else
  echo "  确认无误后：git add -A && git commit -m \"Merge upstream ...\" && git push origin main"
fi
