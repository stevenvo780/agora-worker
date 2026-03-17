
# ── Edu-Worker Shell Configuration ──────────────────────────────
# Enable color support
export TERM=xterm-256color
export COLORTERM=truecolor
force_color_prompt=yes

# ── Colored prompt with git branch ──
parse_git_branch() {
  git branch 2>/dev/null | sed -e '/^[^*]/d' -e 's/* \(.*\)/ (\1)/'
}

# Colorful PS1: [green]user [blue]path [yellow]git-branch [reset]$
PS1='\[\033[01;32m\]\u\[\033[00m\]:\[\033[01;34m\]\w\[\033[33m\]$(parse_git_branch)\[\033[00m\]\$ '

# ── Colors everywhere ──
export LS_COLORS='di=1;34:ln=1;36:so=1;35:pi=33:ex=1;32:bd=1;33;40:cd=1;33;40:su=37;41:sg=30;43:tw=30;42:ow=34;42'
export GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01'

# ── Aliases ──
alias ls='ls --color=auto'
alias ll='ls -alFh --color=auto'
alias la='ls -A --color=auto'
alias l='ls -CF --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'
alias diff='diff --color=auto'

# eza aliases (if available)
if command -v eza &>/dev/null; then
  alias ls='eza --color=auto --icons'
  alias ll='eza -alh --icons --git'
  alias la='eza -a --icons'
  alias lt='eza --tree --level=2 --icons'
fi

# bat alias
if command -v bat &>/dev/null; then
  alias cat='bat --paging=never --style=plain'
  alias catp='bat --paging=always'
  export BAT_THEME="Monokai Extended"
fi

# ── Useful shortcuts ──
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias md='mkdir -p'
alias cls='clear'
alias h='history'
alias path='echo -e ${PATH//:/\\n}'
alias now='date +"%Y-%m-%d %H:%M:%S"'
alias ports='netstat -tulanp 2>/dev/null || ss -tulanp'
alias myip='hostname -I | awk "{print \$1}"'
alias ws='cd /workspace'

# Git aliases
alias gs='git status'
alias ga='git add'
alias gc='git commit'
alias gp='git push'
alias gl='git log --oneline --graph --decorate -20'
alias gd='git diff'

# ── History improvements ──
export HISTSIZE=5000
export HISTFILESIZE=10000
export HISTCONTROL=ignoreboth:erasedups
export HISTTIMEFORMAT="%F %T  "
shopt -s histappend

# ── Navigation improvements ──
shopt -s cdspell 2>/dev/null      # Autocorrect cd typos
shopt -s dirspell 2>/dev/null     # Autocorrect directory names
shopt -s autocd 2>/dev/null       # Type dir name to cd into it
shopt -s globstar 2>/dev/null     # ** matches recursively
shopt -s checkwinsize             # Update LINES/COLUMNS after each command

# ── fzf integration ──
if command -v fzf &>/dev/null; then
  [ -f /usr/share/doc/fzf/examples/key-bindings.bash ] && source /usr/share/doc/fzf/examples/key-bindings.bash
  export FZF_DEFAULT_OPTS='--height 40% --layout=reverse --border --info=inline'
  if command -v fd &>/dev/null; then
    export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
  fi
fi

# ── Completion ──
if ! shopt -oq posix; then
  if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
  fi
fi

# ── Welcome message ──
if [ -z "$WELCOME_SHOWN" ]; then
  export WELCOME_SHOWN=1
  echo -e "\033[1;36m╔═══════════════════════════════════════╗\033[0m"
  echo -e "\033[1;36m║\033[0m  \033[1;33m📚 Edu-Worker Terminal\033[0m              \033[1;36m║\033[0m"
  echo -e "\033[1;36m║\033[0m  \033[0;37mWorkspace: \033[1;32m/workspace\033[0m              \033[1;36m║\033[0m"
  echo -e "\033[1;36m╚═══════════════════════════════════════╝\033[0m"
  echo ""
fi
