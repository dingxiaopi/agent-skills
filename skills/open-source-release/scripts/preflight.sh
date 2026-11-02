#!/usr/bin/env bash
# 公开前的安全检查，覆盖全部 git 历史。只读，不修改仓库，也不联网。
#
# 用法（在要检查的仓库里运行）：
#   bash preflight.sh [--allow-email 邮箱]... [--keyword 关键词]...
#
#   --allow-email  用户同意公开的提交邮箱；其他邮箱算作问题
#   --keyword      不能公开的内容，如真实姓名、私人邮箱、本机路径、服务器 IP；命中算作问题
#
# 退出码：0 无问题（可能仍有“需确认”项）；1 有问题；2 用法或环境错误
#
# 没有检查：二进制文件内容（图片、压缩包等）和第三方内容授权，这些要人工确认。

set -u

allowed_emails=""
keywords=""
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-email) [ $# -ge 2 ] || { echo "$1 需要一个值" >&2; exit 2; }; allowed_emails="$allowed_emails$2
"; shift 2 ;;
    --keyword) [ $# -ge 2 ] || { echo "$1 需要一个值" >&2; exit 2; }; keywords="$keywords$2
"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "当前目录不是 git 仓库" >&2; exit 2; }
git rev-parse HEAD >/dev/null 2>&1 || { echo "仓库还没有提交" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)" || exit 2

problems=0
reviews=0
pass() { echo "[通过] $1"; }
problem() { echo "[问题] $1"; problems=$((problems + 1)); }
review() { echo "[需确认] $1"; reviews=$((reviews + 1)); }
indent() { sed 's/^/    /' | cut -c1-160 | head -n 20; }

history_file=$(mktemp) || exit 2
trap 'rm -f "$history_file"' EXIT
git log --all -p --format='commit %H%n%an <%ae>%n%cn <%ce>%n%B' > "$history_file"

# 1. 提交身份
identities=$(git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u)
if [ -z "$allowed_emails" ]; then
  review "提交身份对所有人可见，请确认都愿意公开："
  echo "$identities" | indent
else
  bad=""
  while IFS= read -r identity; do
    email=${identity##*<}
    email=${email%>}
    printf '%s' "$allowed_emails" | grep -qxF -- "$email" || bad="$bad$identity
"
  done <<< "$identities"
  if [ -n "$bad" ]; then
    problem "历史里有未允许公开的提交身份："
    printf '%s' "$bad" | indent
  else
    pass "提交身份都在允许范围内"
  fi
fi

# 2. 密钥：格式明确的算问题，疑似赋值的需确认
strict='AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-[A-Za-z0-9-]{10,}'
loose='(api[_-]?key|secret|token|password|passwd)[A-Za-z_-]*["'"'"' ]*[:=]["'"'"' ]*[^ "'"'"']{8,}'
hits=$(grep -nEa "$strict" "$history_file" | grep -E '^[0-9]+:[+-]')
if [ -n "$hits" ]; then
  problem "历史里有疑似真实密钥（确认后先作废换新，再清理历史）："
  echo "$hits" | indent
else
  pass "没有发现格式明确的密钥"
fi
hits=$(grep -nEai "$loose" "$history_file" | grep -E '^[0-9]+:[+-]')
if [ -n "$hits" ]; then
  review "历史里有疑似密钥赋值，请看是否为真实值："
  echo "$hits" | indent
fi
if command -v gitleaks >/dev/null 2>&1; then
  if gitleaks git . --no-banner --redact >/dev/null 2>&1; then
    pass "gitleaks 未发现问题"
  else
    problem "gitleaks 报告了问题，运行 gitleaks git . 查看"
  fi
else
  review "gitleaks 未安装，密钥只做了正则搜索"
fi

# 3. 敏感文件：包括已经删除、只留在历史里的
sensitive='(^|/)\.env($|\.)|\.pem$|\.key$|\.p12$|\.sqlite3?$|\.db$|\.dump$|(^|/)credentials'
hits=$(git log --all --name-only --format= | sort -u | grep -Ei "$sensitive" | grep -Ev '\.env\.(example|sample|template)$')
if [ -n "$hits" ]; then
  problem "历史里出现过敏感文件："
  echo "$hits" | indent
else
  pass "历史里没有敏感文件"
fi

# 4. 私人信息
if [ -z "$keywords" ]; then
  review "没有传 --keyword，未搜索真实姓名、私人邮箱、本机路径等私人信息"
else
  found=0
  while IFS= read -r keyword; do
    [ -n "$keyword" ] || continue
    count=$(grep -Faic -- "$keyword" "$history_file")
    if [ "$count" -gt 0 ]; then
      # 不打印关键词本身，避免输出被贴到公开的地方
      problem "第 $((found + 1)) 处私人信息命中：某个 --keyword 在历史里出现 $count 行"
      found=$((found + 1))
    fi
  done <<< "$keywords"
  [ "$found" -eq 0 ] && pass "历史里没有命中任何 --keyword"
fi

# 5. 大文件（超过 10MB）
hits=$(git ls-files -z | xargs -0 du -k 2>/dev/null | awk '$1 > 10240')
if [ -n "$hits" ]; then
  review "有超过 10MB 的文件（前面是 KB），看是否该提交："
  echo "$hits" | indent
else
  pass "没有超过 10MB 的文件"
fi

# 6. 必备文件
for file in README.md LICENSE .gitignore; do
  if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
    pass "已提交 $file"
  else
    problem "缺少 $file"
  fi
done

if [ -n "$(git ls-files README.en.md README.zh-CN.md)" ]; then
  pass "已提交另一语言的 README"
else
  problem "缺少另一语言的 README（README.en.md 或 README.zh-CN.md）"
fi

# 7. 未提交的改动不在上面的检查范围内
if [ -n "$(git status --porcelain)" ]; then
  review "有未提交的改动，以上检查没有覆盖，提交后要再跑一次"
fi

echo
echo "结果：$problems 个问题，$reviews 个需确认"
[ "$problems" -eq 0 ]
