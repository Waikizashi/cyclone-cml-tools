'use strict';

var path = require('path');
var vscode = require('vscode');
var resolver = require('./resolver');

var TYPE_PATTERNS = ['**/*.type', '**/*.inc', '**/*.cml_gen', '**/*.cml_type'];
var TEMPLATE_PATTERNS = ['**/*.tpl', '**/*.body', '**/*.L10n'];
var PERL_PATTERNS = ['**/*.mdl', '**/*.smdl'];
var NAVIGATION_PATTERNS = TYPE_PATTERNS.concat(TEMPLATE_PATTERNS, PERL_PATTERNS);
var CODELENS_PATTERNS = TYPE_PATTERNS.concat(['**/*.tpl', '**/*.body'], PERL_PATTERNS);
var SEMANTIC_TOKEN_TYPES = ['function', 'property', 'parameter', 'variable'];
var SEMANTIC_TOKEN_MODIFIERS = ['readonly', 'declaration'];
var semanticLegend = new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS);

function isNavigableModuleAttrId(attrId) {
  return attrId === '-name' || attrId === '-tpl' || attrId === '-TMP';
}

function hasLiteralValue(attr) {
  return !!(attr && attr.isLiteral !== false && attr.value);
}

function summarizeKeys(prefix, keys) {
  var list = (keys || []).slice(0, 8);
  var suffix = keys.length > list.length ? ', ...' : '';
  return prefix + list.join(', ') + suffix;
}

function collectPathSuggestions(keys, typedPath) {
  var fullPath = typedPath || '';
  var dotIndex = fullPath.lastIndexOf('.');
  var basePath = dotIndex === -1 ? '' : fullPath.slice(0, dotIndex);
  var partial = dotIndex === -1 ? fullPath : fullPath.slice(dotIndex + 1);
  var seen = Object.create(null);
  var result = [];

  (keys || []).forEach(function (key) {
    var remainder = '';
    if (basePath) {
      if (key.indexOf(basePath + '.') !== 0) {
        return;
      }
      remainder = key.slice(basePath.length + 1);
    } else {
      remainder = key;
    }

    var nextSegment = remainder.split('.')[0];
    if (!nextSegment) {
      return;
    }
    if (partial && nextSegment.indexOf(partial) !== 0) {
      return;
    }
    if (seen[nextSegment]) {
      return;
    }
    seen[nextSegment] = true;
    result.push(nextSegment);
  });

  return result.sort();
}

function buildPathCompletionItems(position, typedPath, labels, kind, detail) {
  var fullPath = typedPath || '';
  var dotIndex = fullPath.lastIndexOf('.');
  var partial = dotIndex === -1 ? fullPath : fullPath.slice(dotIndex + 1);
  var replaceRange = new vscode.Range(position.translate(0, -partial.length), position);

  return (labels || []).map(function (label) {
    var item = new vscode.CompletionItem(label, kind);
    item.detail = detail;
    item.range = replaceRange;
    item.insertText = label;
    return item;
  });
}

function activate(context) {
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
    return;
  }

  var workspaceFolder = vscode.workspace.workspaceFolders[0];
  var rootPath = workspaceFolder.uri.fsPath;
  var index = new resolver.WorkspaceIndex(rootPath);
  var diagnostics = vscode.languages.createDiagnosticCollection('cycloneCmlTools');
  var output = vscode.window.createOutputChannel('Cyclone CML Tools');
  var buildTimer = null;
  var buildState = {
    building: false,
    queued: false,
    readyPromise: Promise.resolve()
  };

  function normalizeRelPath(fsPath) {
    return path.relative(rootPath, fsPath).replace(/\\/g, '/');
  }

  function isRelevantDocument(document) {
    return document &&
      document.uri &&
      document.uri.scheme === 'file' &&
      resolver.isRelevantFilePath(normalizeRelPath(document.uri.fsPath));
  }

  function parseCurrentDocument(document) {
    var relPath = normalizeRelPath(document.uri.fsPath);
    var text = document.getText();
    var kind = resolver.detectFileKind(relPath);

    return {
      relPath: relPath,
      kind: kind,
      text: text,
      templateInfo: (kind === 'tpl' || kind === 'xhtml' || kind === 'body') ? resolver.parseTemplateReferences(text) : null,
      typeInfo: kind === 'type' ? resolver.parseTypeReferences(text) : null,
      l10nInfo: kind === 'l10n' ? resolver.parseL10nReferences(text) : null,
      perlInfo: (kind === 'mdl' || kind === 'smdl') ? resolver.parsePerlReferences(text) : null
    };
  }

  function positionRangeFromOffsets(document, start, end) {
    return new vscode.Range(document.positionAt(start), document.positionAt(end));
  }

  function locationFromResult(result) {
    return vscode.workspace.openTextDocument(result.entry.absPath).then(function (targetDocument) {
      return new vscode.Location(
        targetDocument.uri,
        new vscode.Range(targetDocument.positionAt(result.start || 0), targetDocument.positionAt(result.end || 0))
      );
    });
  }

  function openResolvedTargetCommand(target) {
    if (!target || !target.path) {
      return Promise.resolve();
    }

    var targetUri = vscode.Uri.file(target.path);
    return vscode.workspace.openTextDocument(targetUri).then(function (document) {
      return vscode.window.showTextDocument(document, {
        preview: false
      }).then(function (editor) {
        if (typeof target.start === 'number') {
          var start = document.positionAt(target.start);
          var end = document.positionAt(typeof target.end === 'number' ? target.end : target.start);
          editor.selection = new vscode.Selection(start, end);
          editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
      });
    });
  }

  function toOpenTarget(result) {
    return {
      path: result.entry.absPath,
      start: typeof result.start === 'number' ? result.start : 0,
      end: typeof result.end === 'number' ? result.end : 0
    };
  }

  function shortPath(absPath) {
    return normalizeRelPath(absPath);
  }

  function resultsMarkdown(results, includePreview) {
    var markdown = new vscode.MarkdownString('', true);
    var lines = [];
    var i;

    for (i = 0; i < results.length && i < 8; i += 1) {
      var result = results[i];
      var line = '- `' + shortPath(result.entry.absPath) + '`';
      if (includePreview && result.preview) {
        line += ' - ' + result.preview;
      }
      lines.push(line);
    }

    if (!lines.length) {
      markdown.appendMarkdown('No targets resolved.');
      return markdown;
    }

    markdown.appendMarkdown(lines.join('\n'));
    return markdown;
  }

  function log(message) {
    output.appendLine('[Cyclone CML] ' + message);
  }

  function updateVisibleDiagnostics() {
    vscode.workspace.textDocuments.forEach(function (document) {
      if (isRelevantDocument(document)) {
        updateDiagnosticsForDocument(document);
      }
    });
  }

  function buildIndex(reason) {
    if (buildState.building) {
      buildState.queued = true;
      return buildState.readyPromise;
    }

    buildState.building = true;
    buildState.readyPromise = Promise.resolve().then(function () {
      index.rebuild();
      log('Indexed ' + index.fileEntries.length + ' relevant files (' + reason + ').');
      updateVisibleDiagnostics();
    }).catch(function (error) {
      log('Index build failed: ' + (error && error.stack ? error.stack : String(error)));
      vscode.window.showErrorMessage('Cyclone CML Tools failed to index the workspace. See "Cyclone CML Tools" output.');
    }).then(function () {
      buildState.building = false;
      if (buildState.queued) {
        buildState.queued = false;
        return buildIndex('queued rebuild');
      }
      return undefined;
    });

    return buildState.readyPromise;
  }

  function scheduleBuild(reason) {
    if (buildTimer) {
      clearTimeout(buildTimer);
    }
    buildTimer = setTimeout(function () {
      buildTimer = null;
      buildIndex(reason);
    }, 300);
  }

  function findTypeReferenceAt(parsed, offset) {
    var hit = null;

    parsed.typeInfo.includeRefs.forEach(function (includeRef) {
      if (offset >= includeRef.start && offset <= includeRef.end) {
        hit = {
          kind: 'include',
          ref: includeRef
        };
      }
    });

    if (hit) {
      return hit;
    }

    parsed.typeInfo.blocks.forEach(function (block) {
      block.attrList.forEach(function (attr) {
        if (!isNavigableModuleAttrId(attr.id)) {
          return;
        }
        if (offset >= attr.start && offset <= attr.end) {
          hit = {
            kind: 'module-attr',
            block: block,
            attr: attr,
            siblingBlocks: parsed.typeInfo.blocks
          };
        }
      });
    });

    if (hit) {
      return hit;
    }

    parsed.typeInfo.blocks.forEach(function (block) {
      block.attrList.forEach(function (attr) {
        if (attr.sourceAttrKind !== 'key') {
          return;
        }
        if (offset >= attr.start && offset <= attr.end) {
          hit = {
            kind: 'conf-key',
            ref: attr
          };
        }
      });
    });

    return hit;
  }

  function findPerlReferenceAt(parsed, offset) {
    var hit = null;

    parsed.perlInfo.callBlocks.forEach(function (block) {
      block.attrList.forEach(function (attr) {
        if (!isNavigableModuleAttrId(attr.id)) {
          return;
        }
        if (offset >= attr.start && offset <= attr.end) {
          hit = {
            kind: 'module-attr',
            block: block,
            attr: attr,
            siblingBlocks: parsed.perlInfo.callBlocks
          };
        }
      });
    });

    if (hit) {
      return hit;
    }

    parsed.perlInfo.envRefs.forEach(function (envRef) {
      if (offset >= envRef.start && offset <= envRef.end) {
        hit = {
          kind: 'incoming-env',
          ref: envRef
        };
      }
    });

    if (hit) {
      return hit;
    }

    parsed.perlInfo.tomSetupRefs.forEach(function (setupRef) {
      if (offset >= setupRef.start && offset <= setupRef.end) {
        hit = {
          kind: 'domain-setup',
          ref: setupRef
        };
      }
    });

    if (hit) {
      return hit;
    }

    parsed.perlInfo.tplVariableWrites.forEach(function (tplVarRef) {
      if (offset >= tplVarRef.start && offset <= tplVarRef.end) {
        hit = {
          kind: 'tpl-var-write',
          ref: tplVarRef
        };
      }
    });

    return hit;
  }

  function findTemplateReferenceAt(parsed, offset) {
    var hit = null;

    parsed.templateInfo.extendsRefs.forEach(function (extendRef) {
      var targetAttr = extendRef.nameAttr || extendRef.addonAttr;
      if (!targetAttr) {
        return;
      }
      if (offset >= targetAttr.start && offset <= targetAttr.end) {
        hit = {
          kind: 'extend',
          ref: extendRef
        };
      }
    });

    if (hit) {
      return hit;
    }

    parsed.templateInfo.processRefs.forEach(function (processRef) {
      if (offset >= processRef.start && offset <= processRef.end) {
        hit = {
          kind: 'process',
          ref: processRef
        };
      }
    });

    if (hit) {
      return hit;
    }

    parsed.templateInfo.l10nRefs.forEach(function (l10nRef) {
      if (offset >= l10nRef.start && offset <= l10nRef.end) {
        hit = {
          kind: 'l10n',
          ref: l10nRef
        };
      }
    });

    if (hit) {
      return hit;
    }

    parsed.templateInfo.moduleEnvRefs.forEach(function (envRef) {
      if (offset >= envRef.start && offset <= envRef.end) {
        hit = {
          kind: 'incoming-env',
          ref: envRef
        };
      }
    });

    if (hit) {
      return hit;
    }

    parsed.templateInfo.domainSetupRefs.forEach(function (setupRef) {
      if (offset >= setupRef.start && offset <= setupRef.end) {
        hit = {
          kind: 'domain-setup',
          ref: setupRef
        };
      }
    });

    return hit;
  }

  function resolveLocalProcessTargets(parsed, processName) {
    var currentEntry = {
      absPath: path.join(rootPath, parsed.relPath),
      relPath: parsed.relPath
    };
    var results = [];

    parsed.templateInfo.entities.forEach(function (entity) {
      if (entity.id === processName) {
        results.push({
          entry: currentEntry,
          start: entity.start,
          end: entity.end,
          reason: 'same-file'
        });
      }
    });

    return results;
  }

  function resolveHitTargets(parsed, hit) {
    if (!hit) {
      return [];
    }

    if (hit.kind === 'include') {
      return index.resolveIncludeTargets(hit.ref.id, parsed.relPath);
    }

    if (hit.kind === 'conf-key') {
      return index.resolveConfKeyTargets(hit.ref.value, parsed.relPath);
    }

    if (hit.kind === 'module-attr') {
      return index.resolveTypeAttributeTargets(hit.block, hit.attr.id, parsed.relPath, hit.siblingBlocks);
    }

    if (hit.kind === 'process') {
      return resolver.uniqueFileResults(
        resolveLocalProcessTargets(parsed, hit.ref.name).concat(index.resolveProcessTargets(hit.ref.name, parsed.relPath))
      );
    }

    if (hit.kind === 'extend') {
      return index.resolveExtendTargets(hit.ref, parsed.relPath);
    }

    if (hit.kind === 'l10n') {
      return index.resolveL10nTargets(hit.ref.id, parsed.relPath);
    }

    if (hit.kind === 'incoming-env') {
      return index.resolveIncomingEnvTargets(hit.ref.key, parsed.relPath);
    }

    if (hit.kind === 'domain-setup') {
      return index.resolveConfigTargets(hit.ref.key, parsed.relPath);
    }

    if (hit.kind === 'tpl-var-write') {
      return index.resolveTemplateTargetsForTplVariable(hit.ref.key, parsed.relPath);
    }

    return [];
  }

  function buildHover(parsed, hit, targets) {
    var markdown = new vscode.MarkdownString('', true);

    if (hit.kind === 'include') {
      markdown.appendMarkdown('**Cyclone include** `' + hit.ref.id + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'module-attr') {
      var resolved = index.resolveModuleBlockTargets(hit.block, parsed.relPath);
      var spec = resolved.spec;
      var title = hit.attr.id === '-name'
        ? '**Cyclone MODULE file**'
        : (hit.attr.id === '-tpl'
          ? '**Cyclone template file**'
          : '**Cyclone TMP insertion target**');
      markdown.appendMarkdown(title + '\n\n');
      markdown.appendCodeblock(
        [
          'type=' + (spec.type || ''),
          'prefix=' + String(spec.addon || spec.category || '').replace(/^a/i, ''),
          'name=' + (spec.name || ''),
          'version=' + (spec.version || '0'),
          'tpl=' + (spec.tpl || 'default'),
          'level=' + (spec.level || 'auto'),
          'tpl_level=' + (spec.tplLevel || spec.level || 'auto')
        ].join('\n'),
        'text'
      );
      markdown.appendMarkdown('\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'conf-key') {
      markdown.appendMarkdown('**CONF_KEY** `' + hit.ref.value + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets, true).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'process') {
      markdown.appendMarkdown('**PROCESS** `' + hit.ref.name + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'extend') {
      markdown.appendMarkdown('**extend** `' + (hit.ref.name || hit.ref.addon || '') + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'l10n') {
      markdown.appendMarkdown('**L10n** `' + hit.ref.id + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets, true).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'incoming-env') {
      markdown.appendMarkdown('**Incoming env** `' + hit.ref.key + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets, true).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'domain-setup') {
      markdown.appendMarkdown('**domain.setup** `' + hit.ref.key + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets, true).value);
      return new vscode.Hover(markdown);
    }

    if (hit.kind === 'tpl-var-write') {
      markdown.appendMarkdown('**TPL variable** `' + hit.ref.key + '`\n\n');
      markdown.appendMarkdown(resultsMarkdown(targets).value);
      return new vscode.Hover(markdown);
    }

    return null;
  }

  function pushSemanticOffsets(document, builder, start, end, tokenType, modifiers) {
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
      return;
    }
    builder.push(new vscode.Range(document.positionAt(start), document.positionAt(end)), tokenType, modifiers || []);
  }

  function provideDocumentSemanticTokens(document) {
    if (!isRelevantDocument(document)) {
      return Promise.resolve(undefined);
    }

    return buildState.readyPromise.then(function () {
      var parsed = parseCurrentDocument(document);
      var builder = new vscode.SemanticTokensBuilder(semanticLegend);

      if (parsed.typeInfo) {
        parsed.typeInfo.confKeys.forEach(function (confKey) {
          pushSemanticOffsets(document, builder, confKey.start, confKey.end, 'variable', ['declaration']);
        });
        parsed.typeInfo.blocks.forEach(function (block) {
          block.attrList.forEach(function (attr) {
            if (isNavigableModuleAttrId(attr.id)) {
              pushSemanticOffsets(document, builder, attr.start, attr.end, 'property', []);
              return;
            }
            if (attr.sourceAttrKind === 'key' || attr.sourceAttrKind === 'get') {
              pushSemanticOffsets(document, builder, attr.start, attr.end, 'parameter', []);
            }
          });
        });
      }

      if (parsed.templateInfo) {
        parsed.templateInfo.processRefs.forEach(function (processRef) {
          pushSemanticOffsets(document, builder, processRef.start, processRef.end, 'function', []);
        });
        parsed.templateInfo.moduleEnvRefs.forEach(function (envRef) {
          pushSemanticOffsets(document, builder, envRef.start, envRef.end, 'parameter', []);
        });
        parsed.templateInfo.domainSetupRefs.forEach(function (setupRef) {
          pushSemanticOffsets(document, builder, setupRef.start, setupRef.end, 'property', ['readonly']);
        });
      }

      if (parsed.perlInfo) {
        parsed.perlInfo.callBlocks.forEach(function (block) {
          block.attrList.forEach(function (attr) {
            if (isNavigableModuleAttrId(attr.id)) {
              pushSemanticOffsets(document, builder, attr.start, attr.end, 'property', []);
            }
          });
        });
        parsed.perlInfo.envRefs.forEach(function (envRef) {
          pushSemanticOffsets(document, builder, envRef.start, envRef.end, 'parameter', []);
        });
        parsed.perlInfo.tomSetupRefs.forEach(function (setupRef) {
          pushSemanticOffsets(document, builder, setupRef.start, setupRef.end, 'property', ['readonly']);
        });
        parsed.perlInfo.tplVariableWrites.forEach(function (tplVarRef) {
          pushSemanticOffsets(document, builder, tplVarRef.start, tplVarRef.end, 'variable', ['declaration']);
        });
      }

      return builder.build();
    });
  }

  function compactTargetPath(absPath) {
    var rel = shortPath(absPath);
    if (rel.length <= 36) {
      return rel;
    }
    return path.basename(rel);
  }

  function compactHintText(target) {
    var text = '';

    if (target && target.preview) {
      text = String(target.preview).trim();
    }

    if (!text && target && target.entry && target.entry.absPath) {
      text = compactTargetPath(target.entry.absPath);
    }

    text = text || 'unresolved';
    if (text.length <= 52) {
      return text;
    }
    return text.slice(0, 49).trim() + '...';
  }

  function buildHintTooltip(title, targets) {
    var markdown = new vscode.MarkdownString('', true);
    markdown.appendMarkdown('**' + title + '**\n\n');
    markdown.appendMarkdown(resultsMarkdown(targets, true).value);
    return markdown;
  }

  function buildHint(document, endOffset, title, targets) {
    var position = document.positionAt(endOffset);
    var label;
    var hint;

    if (!targets.length) {
      label = ' :[unresolved]';
    } else if (targets.length === 1) {
      label = ' :[' + compactHintText(targets[0]) + ']';
    } else {
      label = ' :[' + compactHintText(targets[0]) + ' +' + (targets.length - 1) + ']';
    }

    hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Type);
    hint.paddingLeft = true;
    hint.tooltip = buildHintTooltip(title, targets);
    if (targets.length) {
      hint.command = {
        title: 'Open target',
        command: 'cycloneCmlTools.openResolvedTarget',
        arguments: [toOpenTarget(targets[0])]
      };
    }
    return hint;
  }

  function provideInlayHints(document) {
    if (!isRelevantDocument(document)) {
      return Promise.resolve([]);
    }

    return buildState.readyPromise.then(function () {
      var parsed = parseCurrentDocument(document);
      var hints = [];

      if (parsed.templateInfo) {
        parsed.templateInfo.moduleEnvRefs.forEach(function (envRef) {
          hints.push(buildHint(
            document,
            envRef.end,
            'Incoming env ' + envRef.key,
            index.resolveIncomingEnvTargets(envRef.key, parsed.relPath)
          ));
        });

        parsed.templateInfo.domainSetupRefs.forEach(function (setupRef) {
          hints.push(buildHint(
            document,
            setupRef.end,
            'domain.setup ' + setupRef.key,
            index.resolveConfigTargets(setupRef.key, parsed.relPath)
          ));
        });
      }

      if (parsed.perlInfo) {
        parsed.perlInfo.envRefs.forEach(function (envRef) {
          hints.push(buildHint(
            document,
            envRef.end,
            'Incoming env ' + envRef.key,
            index.resolveIncomingEnvTargets(envRef.key, parsed.relPath)
          ));
        });

        parsed.perlInfo.tomSetupRefs.forEach(function (setupRef) {
          hints.push(buildHint(
            document,
            setupRef.end,
            '$tom::setup ' + setupRef.key,
            index.resolveConfigTargets(setupRef.key, parsed.relPath)
          ));
        });
      }

      return hints;
    });
  }

  function addUnresolvedModuleDiagnostics(items, document, parsed, blocks) {
    blocks.forEach(function (block) {
      var resolved = index.resolveModuleBlockTargets(block, parsed.relPath);
      var type = String(block.spec.type || '').toLowerCase();

      if ((type === 'mdl' || type === 'smdl') && hasLiteralValue(block.attrsById['-name']) && !resolved.moduleEntries.length) {
        items.push(new vscode.Diagnostic(
          positionRangeFromOffsets(document, block.attrsById['-name'].start, block.attrsById['-name'].end),
          'Cyclone module file was not resolved for this block.',
          vscode.DiagnosticSeverity.Warning
        ));
      }

      if ((type === 'mdl' || type === 'smdl' || type === 'tpl') && hasLiteralValue(block.attrsById['-tpl']) && !resolved.templateEntries.length) {
        items.push(new vscode.Diagnostic(
          positionRangeFromOffsets(document, block.attrsById['-tpl'].start, block.attrsById['-tpl'].end),
          'Cyclone template file was not resolved for this block.',
          vscode.DiagnosticSeverity.Information
        ));
      }

      if (hasLiteralValue(block.attrsById['-TMP']) && !index.resolveTypeAttributeTargets(block, '-TMP', parsed.relPath, blocks).length) {
        items.push(new vscode.Diagnostic(
          positionRangeFromOffsets(document, block.attrsById['-TMP'].start, block.attrsById['-TMP'].end),
          'Cyclone TMP target was not resolved for this block.',
          vscode.DiagnosticSeverity.Information
        ));
      }
    });
  }

  function updateDiagnosticsForDocument(document) {
    if (!isRelevantDocument(document)) {
      diagnostics.delete(document.uri);
      return;
    }

    var parsed = parseCurrentDocument(document);
    var items = [];

    if (parsed.typeInfo) {
      parsed.typeInfo.includeRefs.forEach(function (includeRef) {
        var targets = index.resolveIncludeTargets(includeRef.id, parsed.relPath);
        if (!targets.length) {
          items.push(new vscode.Diagnostic(
            positionRangeFromOffsets(document, includeRef.start, includeRef.end),
            'Cyclone include "' + includeRef.id + '" was not resolved.',
            vscode.DiagnosticSeverity.Warning
          ));
        }
      });

      addUnresolvedModuleDiagnostics(items, document, parsed, parsed.typeInfo.blocks);
    }

    if (parsed.perlInfo) {
      addUnresolvedModuleDiagnostics(items, document, parsed, parsed.perlInfo.callBlocks);
    }

    if (parsed.templateInfo) {
      parsed.templateInfo.processRefs.forEach(function (processRef) {
        var targets = resolver.uniqueFileResults(
          resolveLocalProcessTargets(parsed, processRef.name).concat(index.resolveProcessTargets(processRef.name, parsed.relPath))
        );
        if (!targets.length) {
          items.push(new vscode.Diagnostic(
            positionRangeFromOffsets(document, processRef.start, processRef.end),
            'PROCESS "' + processRef.name + '" was not resolved to any <entity id="..."> in the connected header graph.',
            vscode.DiagnosticSeverity.Warning
          ));
        }
      });

      parsed.templateInfo.extendsRefs.forEach(function (extendRef) {
        var extendTargets = index.resolveExtendTargets(extendRef, parsed.relPath);
        var attr = extendRef.nameAttr || extendRef.addonAttr;
        if (!extendTargets.length && attr) {
          items.push(new vscode.Diagnostic(
            positionRangeFromOffsets(document, attr.start, attr.end),
            'extend "' + (extendRef.name || extendRef.addon || '') + '" was not resolved.',
            vscode.DiagnosticSeverity.Warning
          ));
        }
      });

      parsed.templateInfo.l10nRefs.forEach(function (l10nRef) {
        var l10nTargets = index.resolveL10nTargets(l10nRef.id, parsed.relPath);
        if (!l10nTargets.length) {
          items.push(new vscode.Diagnostic(
            positionRangeFromOffsets(document, l10nRef.start, l10nRef.end),
            'L10n key "' + l10nRef.id + '" was not resolved.',
            vscode.DiagnosticSeverity.Information
          ));
        }
      });
    }

    diagnostics.set(document.uri, items);
  }

  function getHitForDocument(parsed, offset) {
    if (parsed.typeInfo) {
      return findTypeReferenceAt(parsed, offset);
    }
    if (parsed.perlInfo) {
      return findPerlReferenceAt(parsed, offset);
    }
    if (parsed.templateInfo) {
      return findTemplateReferenceAt(parsed, offset);
    }
    return null;
  }

  function provideDefinition(document, position) {
    if (!isRelevantDocument(document)) {
      return Promise.resolve(undefined);
    }

    return buildState.readyPromise.then(function () {
      var parsed = parseCurrentDocument(document);
      var offset = document.offsetAt(position);
      var hit = getHitForDocument(parsed, offset);

      if (!hit) {
        return undefined;
      }

      var targets = resolveHitTargets(parsed, hit);
      if (!targets.length) {
        return undefined;
      }

      return Promise.all(targets.map(locationFromResult));
    });
  }

  function provideHover(document, position) {
    if (!isRelevantDocument(document)) {
      return Promise.resolve(undefined);
    }

    return buildState.readyPromise.then(function () {
      var parsed = parseCurrentDocument(document);
      var offset = document.offsetAt(position);
      var hit = getHitForDocument(parsed, offset);

      if (!hit) {
        return undefined;
      }

      return buildHover(parsed, hit, resolveHitTargets(parsed, hit));
    });
  }

  function provideDocumentLinks(document) {
    if (!isRelevantDocument(document)) {
      return Promise.resolve([]);
    }

    return buildState.readyPromise.then(function () {
      var parsed = parseCurrentDocument(document);
      var links = [];

      function addLink(start, end, targets) {
        if (!targets.length) {
          return;
        }
        links.push(new vscode.DocumentLink(
          positionRangeFromOffsets(document, start, end),
          vscode.Uri.file(targets[0].entry.absPath)
        ));
      }

      if (parsed.typeInfo) {
        parsed.typeInfo.includeRefs.forEach(function (includeRef) {
          addLink(includeRef.start, includeRef.end, index.resolveIncludeTargets(includeRef.id, parsed.relPath));
        });

        parsed.typeInfo.blocks.forEach(function (block) {
          block.attrList.forEach(function (attr) {
            if (!isNavigableModuleAttrId(attr.id)) {
              if (attr.sourceAttrKind === 'key') {
                addLink(attr.start, attr.end, index.resolveConfKeyTargets(attr.value, parsed.relPath));
              }
              return;
            }
            addLink(attr.start, attr.end, index.resolveTypeAttributeTargets(block, attr.id, parsed.relPath, parsed.typeInfo.blocks));
          });
        });
      }

      if (parsed.perlInfo) {
        parsed.perlInfo.callBlocks.forEach(function (block) {
          block.attrList.forEach(function (attr) {
            if (!isNavigableModuleAttrId(attr.id)) {
              return;
            }
            addLink(attr.start, attr.end, index.resolveTypeAttributeTargets(block, attr.id, parsed.relPath, parsed.perlInfo.callBlocks));
          });
        });
      }

      if (parsed.templateInfo) {
        parsed.templateInfo.processRefs.forEach(function (processRef) {
          addLink(
            processRef.start,
            processRef.end,
            resolver.uniqueFileResults(
              resolveLocalProcessTargets(parsed, processRef.name).concat(index.resolveProcessTargets(processRef.name, parsed.relPath))
            )
          );
        });

        parsed.templateInfo.extendsRefs.forEach(function (extendRef) {
          var attr = extendRef.nameAttr || extendRef.addonAttr;
          if (attr) {
            addLink(attr.start, attr.end, index.resolveExtendTargets(extendRef, parsed.relPath));
          }
        });

        parsed.templateInfo.l10nRefs.forEach(function (l10nRef) {
          addLink(l10nRef.start, l10nRef.end, index.resolveL10nTargets(l10nRef.id, parsed.relPath));
        });
      }

      return links;
    });
  }

  function buildBlockOpenLenses(document, parsed, blocks) {
    var lenses = [];

    blocks.forEach(function (block) {
      var resolved = index.resolveModuleBlockTargets(block, parsed.relPath);
      var range = new vscode.Range(document.positionAt(block.start), document.positionAt(block.start));

      if (resolved.moduleEntries.length) {
        lenses.push(new vscode.CodeLens(range, {
          title: 'Open module: ' + shortPath(resolved.moduleEntries[0].entry.absPath),
          command: 'cycloneCmlTools.openResolvedTarget',
          arguments: [toOpenTarget(resolved.moduleEntries[0])]
        }));
      }

      if (resolved.templateEntries.length) {
        lenses.push(new vscode.CodeLens(range, {
          title: 'Open template: ' + shortPath(resolved.templateEntries[0].entry.absPath),
          command: 'cycloneCmlTools.openResolvedTarget',
          arguments: [toOpenTarget(resolved.templateEntries[0])]
        }));
      }
    });

    return lenses;
  }

  function buildSummaryLenses(document, parsed) {
    var lenses = [];
    var range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));

    if (parsed.templateInfo) {
      var incomingKeys = index.collectIncomingEnvKeys(parsed.relPath);
      var tplVarKeys = index.collectTemplateVariableKeys(parsed.relPath);
      var setupKeys = Array.from(new Set(parsed.templateInfo.domainSetupRefs.map(function (item) {
        return item.key;
      }))).sort();

      if (incomingKeys.length) {
        lenses.push(new vscode.CodeLens(range, {
          title: summarizeKeys('module.env: ', incomingKeys)
        }));
      }
      if (tplVarKeys.length) {
        lenses.push(new vscode.CodeLens(range, {
          title: summarizeKeys('TPL vars: ', tplVarKeys)
        }));
      }
      if (setupKeys.length) {
        lenses.push(new vscode.CodeLens(range, {
          title: summarizeKeys('domain.setup: ', setupKeys)
        }));
      }
    }

    if (parsed.perlInfo) {
      var perlIncomingKeys = index.collectIncomingEnvKeys(parsed.relPath);
      var outgoingTplVars = index.collectOutgoingTplVarKeys(parsed.relPath);

      if (perlIncomingKeys.length) {
        lenses.push(new vscode.CodeLens(range, {
          title: summarizeKeys('incoming env: ', perlIncomingKeys)
        }));
      }
      if (outgoingTplVars.length) {
        lenses.push(new vscode.CodeLens(range, {
          title: summarizeKeys('TPL vars: ', outgoingTplVars)
        }));
      }
    }

    return lenses;
  }

  function provideCodeLenses(document) {
    if (!isRelevantDocument(document)) {
      return Promise.resolve([]);
    }

    return buildState.readyPromise.then(function () {
      var parsed = parseCurrentDocument(document);
      var lenses = [];

      if (parsed.typeInfo) {
        lenses = lenses.concat(buildBlockOpenLenses(document, parsed, parsed.typeInfo.blocks));
      }
      if (parsed.perlInfo) {
        lenses = lenses.concat(buildBlockOpenLenses(document, parsed, parsed.perlInfo.callBlocks));
      }

      return lenses;
    });
  }

  function provideCompletionItems(document, position) {
    if (!isRelevantDocument(document)) {
      return undefined;
    }

    var parsed = parseCurrentDocument(document);
    var linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    var items = [];

    if (parsed.templateInfo && /\bPROCESS\s+[A-Za-z0-9_.:-]*$/.test(linePrefix)) {
      index.collectProcessIds(parsed.relPath).forEach(function (id) {
        var item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Function);
        item.detail = 'Cyclone entity id';
        items.push(item);
      });
      return items;
    }

    if (parsed.templateInfo && /L10n\.msg\(\s*["'][^"']*$/.test(linePrefix)) {
      index.collectScopedL10nIds(parsed.relPath).forEach(function (id) {
        var item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Constant);
        item.detail = 'Cyclone L10n id';
        items.push(item);
      });
      return items;
    }

    var typeKeyMatch = linePrefix.match(/\bkey="([^"]*)$/);
    if (parsed.typeInfo && typeKeyMatch) {
      return buildPathCompletionItems(
        position,
        typeKeyMatch[1],
        collectPathSuggestions(index.collectConfKeyNames(parsed.relPath), typeKeyMatch[1]),
        vscode.CompletionItemKind.Variable,
        'CONF_KEY name'
      );
    }

    var moduleEnvDotMatch = linePrefix.match(/module\.env\.([A-Za-z0-9_.-]*)$/);
    if (parsed.templateInfo && moduleEnvDotMatch) {
      return buildPathCompletionItems(
        position,
        moduleEnvDotMatch[1],
        collectPathSuggestions(index.collectIncomingEnvKeys(parsed.relPath), moduleEnvDotMatch[1]),
        vscode.CompletionItemKind.Variable,
        'module.env key'
      );
    }

    var moduleEnvItemMatch = linePrefix.match(/module\.env\.item\(\s*["']([^"']*)$/);
    if (parsed.templateInfo && moduleEnvItemMatch) {
      return buildPathCompletionItems(
        position,
        moduleEnvItemMatch[1],
        collectPathSuggestions(index.collectIncomingEnvKeys(parsed.relPath), moduleEnvItemMatch[1]),
        vscode.CompletionItemKind.Variable,
        'module.env key'
      );
    }

    var domainSetupMatch = linePrefix.match(/domain\.setup\.([A-Za-z0-9_.-]*)$/);
    if (parsed.templateInfo && domainSetupMatch) {
      return buildPathCompletionItems(
        position,
        domainSetupMatch[1],
        collectPathSuggestions(index.collectConfigKeys(parsed.relPath), domainSetupMatch[1]),
        vscode.CompletionItemKind.Property,
        'domain.setup key'
      );
    }

    var perlEnvMatch = linePrefix.match(/\$env\{\s*["']([^"']*)$/);
    if (parsed.perlInfo && perlEnvMatch) {
      return buildPathCompletionItems(
        position,
        perlEnvMatch[1],
        collectPathSuggestions(index.collectIncomingEnvKeys(parsed.relPath), perlEnvMatch[1]),
        vscode.CompletionItemKind.Variable,
        '$env key'
      );
    }

    return undefined;
  }

  context.subscriptions.push(
    diagnostics,
    output,
    vscode.commands.registerCommand('cycloneCmlTools.reindexWorkspace', function () {
      return buildIndex('manual reindex');
    }),
    vscode.commands.registerCommand('cycloneCmlTools.openResolvedTarget', openResolvedTargetCommand)
  );

  NAVIGATION_PATTERNS.forEach(function (pattern) {
    var selector = {
      scheme: 'file',
      pattern: pattern
    };
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: provideDefinition
    }));
    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
      provideHover: provideHover
    }));
    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks: provideDocumentLinks
    }));
    context.subscriptions.push(vscode.languages.registerInlayHintsProvider(selector, {
      provideInlayHints: provideInlayHints
    }));
    context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      provideDocumentSemanticTokens: provideDocumentSemanticTokens
    }, semanticLegend));
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: provideCompletionItems
    }, '.', '\'', '"'));
  });

  CODELENS_PATTERNS.forEach(function (pattern) {
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({
      scheme: 'file',
      pattern: pattern
    }, {
      provideCodeLenses: provideCodeLenses
    }));
  });

  var watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootPath, '**/*'));
  watcher.onDidCreate(function (uri) {
    if (resolver.isRelevantFilePath(normalizeRelPath(uri.fsPath)) || /(?:^|\/)(?:master|local)\.conf$/.test(normalizeRelPath(uri.fsPath))) {
      scheduleBuild('file created');
    }
  });
  watcher.onDidChange(function (uri) {
    if (resolver.isRelevantFilePath(normalizeRelPath(uri.fsPath)) || /(?:^|\/)(?:master|local)\.conf$/.test(normalizeRelPath(uri.fsPath))) {
      scheduleBuild('file changed');
    }
  });
  watcher.onDidDelete(function (uri) {
    if (resolver.isRelevantFilePath(normalizeRelPath(uri.fsPath)) || /(?:^|\/)(?:master|local)\.conf$/.test(normalizeRelPath(uri.fsPath))) {
      scheduleBuild('file deleted');
    }
  });
  context.subscriptions.push(watcher);

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(updateDiagnosticsForDocument));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event) {
    updateDiagnosticsForDocument(event.document);
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(function (document) {
    diagnostics.delete(document.uri);
  }));

  buildIndex('startup');
}

function deactivate() {}

module.exports = {
  activate: activate,
  deactivate: deactivate
};
