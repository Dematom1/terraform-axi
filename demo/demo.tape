# Renders demo/demo.gif. Run from the repository root after `npm run build`:
#   vhs demo/demo.tape
# Uses the throwaway local-backend fixture from demo/fixture.mjs; no real state or credentials.
Output demo/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1100
Set Height 720
Set Padding 20
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Hide
Type `export ROOT="$PWD" DEMO=/tmp/tfaxi-demo && rm -rf "$DEMO" && node demo/fixture.mjs "$DEMO/infra" && cd "$DEMO"` Enter
Type `env -i PATH="$PATH" HOME="$DEMO" ROOT="$ROOT" TERM=xterm-256color CHECKPOINT_DISABLE=1 PS1='$ ' bash --norc --noprofile` Enter
Type `terraform-axi() { node "$ROOT/dist/bin/terraform-axi.js" "$@"; }` Enter
Type "clear" Enter
Sleep 500ms
Show

Type "# Raw Terraform JSON: what an agent would otherwise read" Enter
Type "terraform -chdir=infra plan -json -lock=false | wc -c" Enter
Sleep 4s

Type "terraform-axi plan infra --binary terraform" Enter
Sleep 7s

Type "clear" Enter
Type "# Drift: addresses and actions only, never attribute values" Enter
Type "terraform-axi drift infra --binary terraform" Enter
Sleep 7s

Hide
Type `exit` Enter
Type `rm -rf "$DEMO"` Enter
