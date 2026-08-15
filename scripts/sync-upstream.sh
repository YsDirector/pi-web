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
#      - components/ChatInput.tsx  → 一律取上游版本（fork 已放弃手机模式，用
#        上游 isMobile 自动检测；若以后再想自定义此文件，改这里）。
#      - package.json / package-lock.json → 取上游版本（版本号跟随上游）。
#      - 其余文件（AppShell/ChatWindow/ExtensionWidgets）依赖 git rerere：
#        首次合并需手工解决，此后 rerere 自动套用已记忆的解法。
#   4. next 固定在 16.2.12（16.3.1 在 Node 26 上 SIGBUS 崩溃，见 73db307）。
#   5. npm install --include=dev（install-scripts 被阻止的包需 approve）。
#   6. 构建 + 全量测试，通过后提示提交。
#
# fork 独有功能（合并时保留）：
#   - TodoModal + /api/sessions/[id]/todos（依赖 agent 侧 pi-deck-todo 扩展）
#   - __piDeckBatchAsk__ 批量问卷弹窗（ask-question 扩展的 envelope 协议）
#   - ExtensionDialog secret 密码输入、超时倒计时、代码块高亮
#   - ExtensionWidgets 隐藏 pi-deck-todo 悬浮窗（与 TodoModal 重复）
#   - 备份：backup/custom-features-v0.8.8 分支 + ~/.pi/agent/patches/pi-web-custom-backup/
# ============================================================================

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PUSH="${1:-}"

# 0) 前置检查
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区不干净，请先提交或 stash："
  git status --short | head -20
  exit 1
fi
if ! git remote | grep -q '^upstream$'; then
  echo "✗ 缺少 upstream remote（git remote add upstream git@github.com:agegr/pi-web.git）"
  exit 1
fi
git config rerere.enabled >/dev/null 2>&1 || git config rerere.enabled true

# 1) fetch + merge
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

# 2.5) 已知冲突自动处理
echo "=== [2.5/6] 处理已知冲突 ==="
if [ -f components/ChatInput.tsx ] && grep -q "^<<<<<<<" components/ChatInput.tsx; then
  echo "  ChatInput.tsx → 取上游版本（fork 手机模式已弃用）"
  git checkout --theirs components/ChatInput.tsx
  git add components/ChatInput.tsx
fi
for f in package.json package-lock.json; do
  if [ -f "$f" ] && grep -q "^<<<<<<<" "$f"; then
    echo "  $f → 取上游版本"
    git checkout --theirs "$f"
    git add "$f"
  fi
done

REMAINING=$(git diff --name-only --diff-filter=U || true)
if [ -n "$REMAINING" ]; then
  echo "⚠  剩余冲突需要手工解决（rerere 会自动套用已记忆解法）："
  echo "$REMAINING"
  echo "   AppShell.tsx:     保留 TodoModal 接线（import/state/按钮/TodoModal 渲染）"
  echo "   ChatWindow.tsx:   保留 batch-ask/secret/弹窗增强（parseBatchAskEnvelope+ExtensionDialog）"
  echo "   ExtensionWidgets: 保留 HIDDEN_WIDGET_KEYS 过滤"
  echo "   解决后 git add 这些文件，再运行 $0 继续"
  exit 1
fi

# 3) 依赖 + 版本固定
echo "=== [3/6] 依赖安装（next 固定 16.2.12，Node 26 SIGBUS 规避）==="
# 确保 next 版本固定，避免 install 升级回 16.3.1
grep -q '"next": "16.2.12"' package.json || sed -i 's/"next": "^[0-9.]*"/"next": "16.2.12"/' package.json
timeout 600 npm install --no-audit --no-fund --include=dev || {
  echo "  npm install 后 install-scripts 被阻止的包：npm install-scripts ls / approve"
  exit 1
}
# jiti 偶发丢失（install 覆盖），确保存在
[ -d node_modules/jiti ] || npm install jiti --no-audit --no-fund --include=dev

# 4) 类型检查
echo "=== [4/6] tsc --noEmit ==="
npx tsc --noEmit || { echo "✗ 类型错误"; exit 1; }

# 5) 构建（next 16.2.12）
echo "=== [5/6] next build --webpack ==="
timeout 600 npx next build --webpack || { echo "✗ 构建失败"; exit 1; }

# 6) 测试
echo "=== [6/6] 全量测试 ==="
timeout 600 npm test || { echo "✗ 测试失败"; exit 1; }

echo ""
echo "✓ 合并验证全部通过：upstream $UPSTREAM_HEAD → fork $FORK_HEAD"
if [ "$PUSH" = "--push" ]; then
  git add -A
  git commit -m "Merge upstream main (v$(node -p "require('./package.json').version") | upstream $UPSTREAM_HEAD) into fork" || true
  git push origin main
  echo "✓ 已提交并推送到 origin/main"
else
  echo "  确认无误后：git add -A && git commit -m \"Merge upstream ...\" && git push origin main"
fi
