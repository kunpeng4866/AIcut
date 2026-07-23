#!/bin/bash
# 扫描已安装的 Claude Code 插件，自动将其 skills/ 链接到 ~/.claude/skills/
# 用法: bash link-plugin-skills.sh

PLUGIN_CACHE="$HOME/.claude/plugins/cache"
SKILLS_DIR="$HOME/.claude/skills"
LINKED=0
SKIPPED=0

mkdir -p "$SKILLS_DIR"

# 遍历所有已安装插件
for publisher in "$PLUGIN_CACHE"/*/; do
  for plugin in "$publisher"*/; do
    for version in "$plugin"*/; do
      skills_src="$version/skills"
      if [ -d "$skills_src" ]; then
        for skill_dir in "$skills_src"/*/; do
          skill_name=$(basename "$skill_dir")
          # 只链接含 SKILL.md 的目录
          if [ -f "$skill_dir/SKILL.md" ]; then
            target="$SKILLS_DIR/$skill_name"
            if [ -e "$target" ]; then
              ((SKIPPED++))
            else
              ln -s "$skill_dir" "$target" 2>/dev/null && ((LINKED++))
            fi
          fi
        done
      fi
    done
  done
done

echo "链接: $LINKED, 已存在: $SKIPPED"
