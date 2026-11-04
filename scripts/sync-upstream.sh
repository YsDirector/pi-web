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
#      - package-lock.json → 整份取上游，随后由 npm install 按 package.json 重生成。
#      - package.json → **不能**整份取上游：fork 有上游没有的顶层键（allowScripts）。
#        改为「以上游为底 + 补回 fork 独有的顶层键」的逐键合并。
#      - public/sw.js → 默认取 fork 版本。fork 改写了上游的缓存策略（static 资源用
#        networkFirst 取代 cacheFirst，导航加离线 shell 回放，另有会话数据缓存），
#        但两者共有的超时兜底（fetchWithTimeout / NAVIGATION_TIMEOUT_MS /
#        ASSET_TIMEOUT_MS）一致。脚本先做一次守卫：只比较上游**新引入**的顶层标识符
#        （= 上游声明 ∖ (fork HEAD ∪ merge-base)）；命中则**放弃自动化**、留冲突给人工，
#        避免上游将来新增的 sw 修复被静默丢掉。
#      - 其余文件依赖 git rerere：首次合并需手工解决，此后 rerere 自动套用记忆的解法。
#      - ChatInput.tsx 不再有 fork 专属的 slash-command 逻辑，跟随上游版本即可。
#   4. next 跟随上游，**不再钉版本**（v0.15.0 起）：16.2.12 的钉是为规避 16.3.1 在
#      Node 26 上的 SIGBUS（退出码 135，见 73db307/d7c4c50）。2026-11-04 实测
#      next 16.4.4 + Node 26.12.1：`next build --webpack` EXIT=0，无 SIGBUS。
#      若日后某个小版本回归该崩溃，把下面「版本变化丢 .next」的逻辑配上一次钉版本即可。
#   5. npm install --include=dev（install-scripts 被阻止的包需 approve）。
#   6. 构建 + 全量测试，通过后提示提交。
#
# fork 独有功能（合并时保留）：
#   - bash-bg 后台任务回执卡片（components/BackgroundJobMessage.* + MessageView 接线）
#   - ExtensionDialog secret 密码输入、超时到点自动取消、标题首行钉住 + 代码围栏高亮
#   - 离线 shell/会话数据缓存与永不黑屏的 PWA fallback
#   - 扩展状态栏单行不换行 + 横向滚动；本地 Noto Sans Mono（构建不依赖外网）
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
# package-lock.json：整份取上游，随后 npm install 会按 package.json（含 next 的实际版本）
# 重生成整份锁；留着 fork 侧旧的 next/swc/sharp 锁条目反而会让 install 多下载一遍。
if [ -f package-lock.json ] && grep -q "^<<<<<<<" package-lock.json; then
  echo "  package-lock.json → 取上游版本（随后 npm install 重生成）"
  git checkout --theirs package-lock.json
  git add package-lock.json
fi

# package.json：**不能**整份取上游。fork 有上游没有的顶层键（`allowScripts`：npm 11+ 的
# install-scripts 白名单），旧写法 `git checkout --theirs package.json` 会把它一起丢掉，
# 随后 npm install 就会因 postinstall 被拦而装不好 node-pty/sharp。
# 两个 stage 的 blob 都是干净 JSON，所以以上游为底、把「上游没有的 fork 顶层键」补回去即可。
if [ -f package.json ] && grep -q "^<<<<<<<" package.json; then
  echo "  package.json → 以上游为底 + 补回 fork 独有的顶层键"
  PKG_TMP=$(mktemp -d)
  git show ":2:package.json" > "$PKG_TMP/ours.json"
  git show ":3:package.json" > "$PKG_TMP/theirs.json"
  node - "$PKG_TMP/ours.json" "$PKG_TMP/theirs.json" "$PKG_TMP/merged.json" <<'NODE'
const fs = require("fs");
const [oursPath, theirsPath, outPath] = process.argv.slice(2);
const ours = JSON.parse(fs.readFileSync(oursPath, "utf8"));
const merged = JSON.parse(fs.readFileSync(theirsPath, "utf8"));
for (const [key, value] of Object.entries(ours)) {
  if (!(key in merged)) merged[key] = value; // fork 独有的顶层键（allowScripts 等）
}
fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
NODE
  cp "$PKG_TMP/merged.json" package.json
  rm -rf "$PKG_TMP"
  git add package.json
fi

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
  已知解法（v0.15.0 基线；完整预案见 ~/dev/pi-web-v0.15.0-merge-plan.md §2）：
    components/ChatWindow.tsx   —— 三处冲突都在扩展对话框的标题渲染
        上游 v0.14 起把标题统一成 stripAnsi(request.title)，fork 是 splitDialogTitle()
        切出来的 {titleHead}（首行钉在表头）+ titleRest（正文渲染 ```sh 围栏）。
        解法：三处一律取 fork 的 {titleHead} / aria-label={titleHead}（连 aria-modal="true"），
        并把切分入口改成
            const { head: titleHead, rest: titleRest } = splitDialogTitle(stripAnsi(request.title));
        否则带 ANSI 的标题会显示原始转义序列。lib/dialog-title.ts 保持纯函数，不要在那里 strip。
    package.json
        next 跟随上游（不再钉 16.2.12）；保留 fork 的 allowScripts 块
    package-lock.json
        整份取上游，随后 npm install 重生成（会与上游锁逐字节相同）
    public/sw.js / public/sw.test.mjs
        通常能自动合并（上游 v0.15.0 新增 RECENT_NOTIFICATION_MS / showPushNotification /
        hasRecentNotification 三个顶层标识符，与 fork 的离线缓存区域不重叠）。
        若 sw.js 真的冲突：保留 fork 的 SHELL_CACHE/DATA_CACHE/networkFirst/离线 shell，
        并把上游新增的 push 去重函数一并并入。
    components/ExtensionStatusBar.test.mjs
        上游改成 ANSI 调色板断言（class="ansi-green-fg"），fork 是单行不换行 CSS 断言，两段共存。
    app/layout.tsx / app/globals.css
        上游改 manifest link / --ansi-* 调色板，fork 改本地字体 / 状态栏单行，彼此不重叠。
  解决后 git add 这些文件，再运行 $0 继续
GUIDE
  exit 1
fi

# 3) 依赖 + 版本
# next 从 v0.15.0 起跟随上游（不再钉 16.2.12）。前缀记录的 PREV_NEXT 只用于下面
# 「版本变化 → 丢弃陈旧 .next」的判定。
echo "=== [3/6] 依赖安装 ==="
# 记录安装前的 next 版本：版本变化时必须丢弃 .next，否则陈旧生成物会毒害后续步骤
PREV_NEXT=$(node -p "require('./node_modules/next/package.json').version" 2>/dev/null || echo none)
timeout 600 npm install --no-audit --no-fund --include=dev --prefer-offline \
  --fetch-retries=20 --fetch-retry-maxtimeout=180000 --fetch-timeout=1800000 || {
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

# 5) 构建（next 跟随上游；unset TURBOPACK —— 桌面环境该变量与 --webpack 冲突会静默退出）
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
  # 备份只留最近 1 份——**必须放在重启之前**：重启会连本脚本一起杀掉（见下），
  # 放在重启之后就执行不到，旧备份会一路攒到 10GB+（v0.13.0 部署时实测攒了 4 组）。
  ls -dt "$DEPLOY_DIR"/.next.old-* 2>/dev/null | tail -n +2 | xargs -r rm -rf
  ls -dt "$DEPLOY_DIR"/node_modules.old-* 2>/dev/null | tail -n +2 | xargs -r rm -rf

  # 重启 + 健康检查不能在本脚本里跑。pi-web.service 是 KillMode=control-group，
  # `systemctl --user restart` 会对整个 cgroup 发 SIGTERM，本脚本是它的子孙进程所以
  # 一起死——历史实现用 `setsid` 也没用，setsid 只换 session/process group，不换 cgroup。
  # 只有**不带 --scope** 的瞬态 service 是目标单元的兄弟而非子孙，能活过重启。
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  UNIT="pi-web-deploy-$TS"
  HEALTH_SCRIPT="/tmp/pi-web-deploy-health-$TS.sh"
  cat > "$HEALTH_SCRIPT" <<HEALTH
#!/usr/bin/env bash
# 由 sync-upstream.sh 的 --deploy 生成，跑在 pi-web.service 之外的瞬态单元里。
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}"
DEPLOY_DIR="$DEPLOY_DIR"
TS="$TS"
systemctl --user restart pi-web
for _ in \$(seq 1 40); do
  if curl -sf -o /dev/null http://127.0.0.1:30141/; then
    echo "✓ 部署完成，服务健康：http://127.0.0.1:30141（备份保留一份：.next.old-\$TS）"
    echo "  pi-web \$(node -p "require('\$DEPLOY_DIR/package.json').version" 2>/dev/null)"
    echo "  next   \$(node -p "require('\$DEPLOY_DIR/node_modules/next/package.json').version" 2>/dev/null)"
    echo "  pi SDK \$(node -p "require('\$DEPLOY_DIR/node_modules/@earendil-works/pi-coding-agent/package.json').version" 2>/dev/null)"
    exit 0
  fi
  sleep 2
done
echo "✗ 服务未响应，请检查：systemctl --user status pi-web"
echo "  回滚：mv \$DEPLOY_DIR/.next.old-\$TS \$DEPLOY_DIR/.next; mv \$DEPLOY_DIR/node_modules.old-\$TS \$DEPLOY_DIR/node_modules; systemctl --user restart pi-web"
exit 1
HEALTH
  chmod +x "$HEALTH_SCRIPT"
  echo "  重启由瞬态单元 $UNIT 执行（本脚本的 cgroup 会被一起杀掉，重启后的步骤不能在这里跑）"
  systemd-run --user --collect --unit="$UNIT" \
    --description="pi-web deploy restart + health check ($TS)" \
    -- bash "$HEALTH_SCRIPT" || { echo "✗ systemd-run 启动瞬态单元失败"; exit 1; }
  echo "  服务将在数秒后重启，本脚本随之结束——这是正常的。"
  echo "  查看结果：journalctl --user -u $UNIT -n 20 --no-pager"
  exit 0
fi

if [ "$PUSH" = "--push" ]; then
  git add -A
  git commit -m "Merge upstream main (v$(node -p "require('./package.json').version") | upstream $UPSTREAM_HEAD) into fork" || true
  git push origin main
  echo "✓ 已提交并推送到 origin/main"
else
  echo "  确认无误后：git add -A && git commit -m \"Merge upstream ...\" && git push origin main"
fi
