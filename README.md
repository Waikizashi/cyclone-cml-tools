# Cyclone CML Tools

VS Code extension for the Cyclone/STVR project layout.

What it does:

- `Ctrl+Click` / Go to Definition for `PROCESS some_id`
- `Ctrl+Click` for `<extend ... name="...">` and `<extend addon="...">`
- `Ctrl+Click` in `.type/.inc/.cml_gen/.cml_type` for module/template/include references
- `Ctrl+Click` in `.smdl` / `.mdl` for `Tomahawk::module(...)` and `Tomahawk::tplmodule(...)` `-name` / `-tpl` / `-TMP`
- `Ctrl+Click` for `L10n.msg('text_id')`
- hover/definition for `module.env.*`, `$env{...}`, `domain.setup.*`, `$tom::setup{...}`, `$TPL->{variables}{...}`
- semantic highlighting for `PROCESS`, `module.env`, `$env`, `domain.setup`, `$tom::setup`, `$TPL->{variables}`
- completion for `PROCESS`, `L10n.msg(...)`, `module.env.*`, `$env{...}`, `domain.setup.*`
- hover summaries for resolved targets
- CodeLens above `<MODULE>` / `Tomahawk::*` blocks with direct open actions
- file-level CodeLens summaries for incoming env, `TPL vars`, and `domain.setup` keys
- diagnostics for unresolved `PROCESS`, `extend`, `L10n`, `includes/layers`, module/template targets

The resolver understands:

- master/local/global scope
- root, subdomain, `json`, `xml`, `subdomain/json`, `subdomain/xml` branches
- `_mdl`, `_type`, `_dsgn`
- `.xhtml.tpl` header graphs used through `PROCESS`
- `.L10n` string ids used through `L10n.msg(...)`
- `.smdl` Perl `Tomahawk::*` call chains
- `master.conf` + layered `local.conf` files for `domain.setup.*`
- symlinked directories/files without recursive indexing loops

Workspace helper files are also placed next to the extension:

- `.vscode/settings.json` associates Cyclone template files with `tpl` and `.mdl/.smdl` with Perl
- the packaged `.vsix` is generated into `.vscode/cyclone-cml-tools/`

Build/package:

```bash
cd .vscode/cyclone-cml-tools
npm run smoke:test
npm run package:vsix
```
