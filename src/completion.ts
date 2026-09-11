import { COMMANDS } from "./commands.js";
import { fail, type Ctx } from "./output.js";

const names = () => COMMANDS.map((c) => c.name).join(" ");
const flags = () => [...new Set(COMMANDS.flatMap((c) => c.options.map((o) => `--${o.long}`)))].join(" ");

// ponytail: static scripts from the table — no runtime introspection, no drift.
export function printCompletion(shell: string, ctx: Ctx) {
  if (shell === "bash") {
    console.log(`# beamline bash completion — install:
# beamline completion bash > ~/.local/share/bash-completion/completions/beamline
_beamline() {
  local cur prev cmds="${names()}"
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
    return 0
  fi
  case "$prev" in
    --hook) COMPREPLY=($(compgen -W "lines claude" -- "$cur")) ;;
    completion) COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur")) ;;
    *) COMPREPLY=($(compgen -W "${flags()}" -- "$cur")) ;;
  esac
}
complete -F _beamline beamline`);
  } else if (shell === "zsh") {
    console.log(`# beamline zsh completion — install:
# beamline completion zsh > /usr/local/share/zsh/site-functions/_beamline
#compdef beamline
_beamline() {
  local -a cmds
  cmds=(${COMMANDS.map((c) => `"${c.name}:${c.description.replace(/"/g, "")}"`).join("\n  ")})
  _arguments -C '1:command:->cmd' '*:: :->args' && return
  case $state in
    cmd) _describe 'command' cmds ;;
    args) _arguments ${COMMANDS.map((c) => `"${c.name}:*::->${c.name}"`).join(" ")} 2>/dev/null; compadd ${flags()} ;;
  esac
}
_beamline`);
  } else if (shell === "fish") {
    console.log(`# beamline fish completion — install:
# beamline completion fish > ~/.config/fish/completions/beamline.fish
${COMMANDS.map((c) => `complete -c beamline -n __fish_use_subcommand -f -a ${c.name} -d '${c.description.replace(/'/g, "")}'`).join("\n")}
complete -c beamline -s h -l help -d 'Show help'
complete -c beamline -l version -d 'Show version'`);
  } else {
    fail({ ...ctx, command: "completion" }, `unknown shell '${shell}'`, "use one of: bash, zsh, fish");
  }
}
