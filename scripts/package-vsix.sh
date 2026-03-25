#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_JSON="$ROOT_DIR/package.json"
PACKAGE_NAME="$(node -e "console.log(require(process.argv[1]).name)" "$PACKAGE_JSON")"
PACKAGE_VERSION="$(node -e "console.log(require(process.argv[1]).version)" "$PACKAGE_JSON")"
VSIX_NAME="${PACKAGE_NAME}-${PACKAGE_VERSION}.vsix"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/extension"

cp "$ROOT_DIR/package.json" "$TMP_DIR/extension/package.json"
cp "$ROOT_DIR/README.md" "$TMP_DIR/extension/README.md"
cp "$ROOT_DIR/extension.js" "$TMP_DIR/extension/extension.js"
cp "$ROOT_DIR/resolver.js" "$TMP_DIR/extension/resolver.js"
cp "$ROOT_DIR/language-configuration.json" "$TMP_DIR/extension/language-configuration.json"
cp "$ROOT_DIR/[Content_Types].xml" "$TMP_DIR/[Content_Types].xml"
mkdir -p "$TMP_DIR/extension/syntaxes"
cp "$ROOT_DIR/syntaxes/tpl.tmLanguage.json" "$TMP_DIR/extension/syntaxes/tpl.tmLanguage.json"

node - "$TMP_DIR/extension.vsixmanifest" "$PACKAGE_JSON" <<'NODE'
const fs = require('fs');
const outputPath = process.argv[2];
const pkg = require(process.argv[3]);

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const manifest = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
  '  <Metadata>',
  '    <Identity Id="' + xmlEscape(pkg.name) + '" Version="' + xmlEscape(pkg.version) + '" Language="en-US" Publisher="' + xmlEscape(pkg.publisher) + '" />',
  '    <DisplayName>' + xmlEscape(pkg.displayName) + '</DisplayName>',
  '    <Description xml:space="preserve">' + xmlEscape(pkg.description) + '</Description>',
  '    <Tags>' + xmlEscape((pkg.keywords || []).join(' ')) + '</Tags>',
  '    <Categories>' + xmlEscape((pkg.categories || ['Other']).join(',')) + '</Categories>',
  '    <Properties>',
  '      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="' + xmlEscape(pkg.engines && pkg.engines.vscode) + '" />',
  '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="' + xmlEscape((pkg.extensionKind || ['workspace']).join(',')) + '" />',
  '    </Properties>',
  '  </Metadata>',
  '  <Installation>',
  '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />',
  '  </Installation>',
  '  <Dependencies />',
  '  <Assets>',
  '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
  '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />',
  '  </Assets>',
  '</PackageManifest>',
  ''
].join('\n');

fs.writeFileSync(outputPath, manifest, 'utf8');
NODE

rm -f "$ROOT_DIR/$VSIX_NAME"
(
  cd "$TMP_DIR"
  zip -qr "$ROOT_DIR/$VSIX_NAME" "[Content_Types].xml" "extension.vsixmanifest" "extension"
)

printf 'Packed %s\n' "$ROOT_DIR/$VSIX_NAME"
