'use strict';

var fs = require('fs');
var path = require('path');

var TYPE_LIKE_EXTENSIONS = {
  '.type': true,
  '.inc': true,
  '.cml_gen': true,
  '.cml_type': true
};

var RELEVANT_FILE_RE = /\.(?:tpl|body|mdl|smdl|type|L10n|inc|cml_gen|cml_type)$/;
var CONFIG_FILE_RE = /(?:^|\/)(?:master|local)\.conf$/;
var SKIP_DIRS = {
  '.git': true,
  '.idea': true,
  '.svn': true,
  '.vscode': true,
  '!www': true,
  '!media': true,
  'node_modules': true,
  '_data': true,
  '_logs': true,
  '_temp': true,
  '.libs': true
};

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relativePath(rootPath, absPath) {
  return normalizeSlashes(path.relative(rootPath, absPath));
}

function uniqueStrings(values) {
  var seen = Object.create(null);
  var result = [];
  values.forEach(function (value) {
    if (!value && value !== '') {
      return;
    }
    if (seen[value]) {
      return;
    }
    seen[value] = true;
    result.push(value);
  });
  return result;
}

function uniqueFileResults(values) {
  var seen = Object.create(null);
  var result = [];
  values.forEach(function (value) {
    if (!value || !value.entry) {
      return;
    }
    var key = value.entry.relPath + ':' + (value.start || 0) + ':' + (value.end || 0);
    if (seen[key]) {
      return;
    }
    seen[key] = true;
    result.push(value);
  });
  return result;
}

function uniqueEntries(entries) {
  var seen = Object.create(null);
  var result = [];
  entries.forEach(function (entry) {
    if (!entry || seen[entry.relPath]) {
      return;
    }
    seen[entry.relPath] = true;
    result.push(entry);
  });
  return result;
}

function startsWithSegment(relPath, segment) {
  if (segment === '') {
    return true;
  }
  if (!segment) {
    return false;
  }
  return relPath === segment || relPath.indexOf(segment + '/') === 0;
}

function stripTags(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function previewText(value, maxLength) {
  var clean = stripTags(value);
  if (clean.length <= maxLength) {
    return clean;
  }
  return clean.slice(0, maxLength - 3).trim() + '...';
}

function previewLine(text, start) {
  var value = String(text || '');
  var from = value.lastIndexOf('\n', Math.max(0, start - 1));
  var to = value.indexOf('\n', start);
  var snippet = value.slice(from === -1 ? 0 : from + 1, to === -1 ? value.length : to);
  return snippet.trim();
}

function isTypeLikeFile(relPath) {
  var ext = path.extname(relPath);
  return !!TYPE_LIKE_EXTENSIONS[ext];
}

function isRelevantFilePath(relPath) {
  return RELEVANT_FILE_RE.test(relPath || '');
}

function detectFileKind(relPath) {
  var normalized = normalizeSlashes(relPath);
  if (/\.L10n$/i.test(normalized)) {
    return 'l10n';
  }
  if (/\.xhtml\.tpl$/i.test(normalized)) {
    return 'xhtml';
  }
  if (/\.body$/i.test(normalized)) {
    return 'body';
  }
  if (/\.tpl$/i.test(normalized)) {
    return 'tpl';
  }
  if (/\.smdl$/i.test(normalized)) {
    return 'smdl';
  }
  if (/\.mdl$/i.test(normalized)) {
    return 'mdl';
  }
  if (isTypeLikeFile(normalized)) {
    return 'type';
  }
  return 'other';
}

function getDirectoryRole(relPath) {
  var normalized = normalizeSlashes(relPath);
  var marker = normalized.match(/(^|\/)(_mdl|_type|_dsgn)(\/|$)/);
  return marker ? marker[2] : '';
}

function getScopeInfo(relPath) {
  var normalized = normalizeSlashes(relPath);
  var segments = normalized.split('/');
  var markerIndex = -1;
  var i;

  for (i = 0; i < segments.length; i += 1) {
    if (/^_(mdl|type|dsgn)$/.test(segments[i])) {
      markerIndex = i;
      break;
    }
  }

  var scopeSegments = markerIndex === -1 ? [] : segments.slice(0, markerIndex);
  var branchSegments = scopeSegments.slice();
  var localScopeSegment = null;

  if (branchSegments.length && branchSegments[0] !== 'json' && branchSegments[0] !== 'xml') {
    localScopeSegment = branchSegments[0];
    branchSegments = branchSegments.slice(1);
  }

  return {
    relPath: normalized,
    scopeSegments: scopeSegments,
    branchSegments: branchSegments,
    localScopeSegment: localScopeSegment,
    localRoot: scopeSegments.join('/'),
    masterRoot: branchSegments.join('/')
  };
}

function getRootsForLevel(scopeInfo, level) {
  var normalizedLevel = String(level || 'auto').toLowerCase();
  var localRoot = scopeInfo.localRoot || scopeInfo.masterRoot || '';
  var masterRoot = scopeInfo.masterRoot || '';
  var roots;

  if (normalizedLevel === 'master' || normalizedLevel === 'global') {
    roots = [masterRoot, localRoot, ''];
  } else if (normalizedLevel === 'local') {
    roots = [localRoot, masterRoot, ''];
  } else {
    roots = [localRoot, masterRoot, ''];
  }

  return uniqueStrings(roots);
}

function getLeadingNumericPrefix(fileName) {
  var match = String(fileName || '').match(/^(\d{1,4})-/);
  return match ? match[1] : '';
}

function parseTagAttributes(tagText, baseOffset) {
  var attrs = Object.create(null);
  var attrRe = /\b([A-Za-z0-9_.:-]+)="([^"]*)"/g;
  var match;

  while ((match = attrRe.exec(tagText)) !== null) {
    var raw = match[0];
    var value = match[2];
    var valueOffset = match.index + raw.indexOf('"') + 1;
    attrs[match[1]] = {
      name: match[1],
      value: value,
      start: baseOffset + valueOffset,
      end: baseOffset + valueOffset + value.length
    };
  }

  return attrs;
}

function buildModuleBlock(attrList, extra) {
  var attrsById = Object.create(null);
  var allAttrsById = Object.create(null);

  attrList.forEach(function (attr) {
    attrsById[attr.id] = attr;
    if (!allAttrsById[attr.id]) {
      allAttrsById[attr.id] = [];
    }
    allAttrsById[attr.id].push(attr);
  });

  return {
    start: extra.start,
    end: extra.end,
    callType: extra.callType || '',
    sourceKind: extra.sourceKind || '',
    attrsById: attrsById,
    allAttrsById: allAttrsById,
    attrList: attrList,
    spec: {
      type: attrsById['-type'] ? attrsById['-type'].value : '',
      addon: attrsById['-addon'] ? attrsById['-addon'].value : '',
      category: attrsById['-category'] ? attrsById['-category'].value : '',
      name: attrsById['-name'] ? attrsById['-name'].value : '',
      version: attrsById['-version'] ? attrsById['-version'].value : '',
      tpl: attrsById['-tpl'] ? attrsById['-tpl'].value : '',
      level: attrsById['-level'] ? attrsById['-level'].value : '',
      tplLevel: attrsById['-tpl_level'] ? attrsById['-tpl_level'].value : ''
    }
  };
}

function parseTemplateReferences(text) {
  var entities = [];
  var extendsRefs = [];
  var headerExtendsRefs = [];
  var processRefs = [];
  var l10nRefs = [];
  var tmpTags = [];
  var moduleEnvRefs = [];
  var domainSetupRefs = [];
  var match;
  var entityRe = /<entity\b[^>]*\bid="([^"]+)"/g;
  var extendRe = /<extend\b[^>]*\/?>/g;
  var processRe = /\bPROCESS\s+([A-Za-z0-9_.:-]+)/g;
  var l10nRe = /L10n\.msg\(\s*(["'])([^"']+)\1\s*\)/g;
  var tmpRe = /<!TMP-([A-Z0-9_-]+)!>/g;
  var moduleEnvItemRe = /module\.env\.item\(\s*(["'])([^"']+)\1\s*\)/g;
  var moduleEnvDotRe = /module\.env\.(?!item\s*\()([A-Za-z0-9_.-]+)/g;
  var domainSetupRe = /domain\.setup\.([A-Za-z0-9_.-]+)/g;
  var headerRanges = [];
  var headerRe = /<header\b[^>]*>([\s\S]*?)<\/header>/gi;

  while ((match = headerRe.exec(text)) !== null) {
    headerRanges.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }

  while ((match = entityRe.exec(text)) !== null) {
    var entityValueOffset = match.index + match[0].indexOf('"') + 1;
    entities.push({
      id: match[1],
      start: entityValueOffset,
      end: entityValueOffset + match[1].length
    });
  }

  while ((match = extendRe.exec(text)) !== null) {
    var attrs = parseTagAttributes(match[0], match.index);
    if (attrs.name || attrs.addon) {
      var extendRef = {
        name: attrs.name ? attrs.name.value : '',
        addon: attrs.addon ? attrs.addon.value : '',
        level: attrs.level ? attrs.level.value : 'auto',
        contentType: attrs['content-type'] ? attrs['content-type'].value : '',
        nameAttr: attrs.name || null,
        addonAttr: attrs.addon || null,
        start: match.index,
        end: match.index + match[0].length
      };

      extendsRefs.push(extendRef);
      if (headerRanges.some(function (range) {
        return extendRef.start >= range.start && extendRef.end <= range.end;
      })) {
        headerExtendsRefs.push(extendRef);
      }
    }
  }

  while ((match = processRe.exec(text)) !== null) {
    var processStart = match.index + match[0].lastIndexOf(match[1]);
    processRefs.push({
      name: match[1],
      start: processStart,
      end: processStart + match[1].length
    });
  }

  while ((match = l10nRe.exec(text)) !== null) {
    var l10nStart = match.index + match[0].lastIndexOf(match[2]);
    l10nRefs.push({
      id: match[2],
      start: l10nStart,
      end: l10nStart + match[2].length
    });
  }

  while ((match = tmpRe.exec(text)) !== null) {
    var tmpStart = match.index + '<!TMP-'.length;
    tmpTags.push({
      id: match[1],
      start: tmpStart,
      end: tmpStart + match[1].length
    });
  }

  while ((match = moduleEnvItemRe.exec(text)) !== null) {
    moduleEnvRefs.push({
      key: match[2],
      start: match.index,
      end: match.index + match[0].length
    });
  }

  while ((match = moduleEnvDotRe.exec(text)) !== null) {
    moduleEnvRefs.push({
      key: match[1],
      start: match.index,
      end: match.index + match[0].length
    });
  }

  while ((match = domainSetupRe.exec(text)) !== null) {
    domainSetupRefs.push({
      key: match[1],
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return {
    entities: entities,
    extendsRefs: extendsRefs,
    headerExtendsRefs: headerExtendsRefs,
    processRefs: processRefs,
    l10nRefs: l10nRefs,
    tmpTags: tmpTags,
    moduleEnvRefs: uniqueKeyRefs(moduleEnvRefs),
    domainSetupRefs: uniqueKeyRefs(domainSetupRefs)
  };
}

function uniqueKeyRefs(values) {
  var seen = Object.create(null);
  var result = [];
  values.forEach(function (value) {
    if (!value) {
      return;
    }
    var key = value.key + ':' + value.start + ':' + value.end;
    if (seen[key]) {
      return;
    }
    seen[key] = true;
    result.push(value);
  });
  return result;
}

function parseL10nReferences(text) {
  var strings = [];
  var stringRe = /<string\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
  var match;

  while ((match = stringRe.exec(text)) !== null) {
    var idStart = match.index + match[0].indexOf('"') + 1;
    strings.push({
      id: match[1],
      start: idStart,
      end: idStart + match[1].length,
      preview: previewText(match[2], 140)
    });
  }

  return {
    strings: strings
  };
}

function parseTypeReferences(text) {
  var blocks = [];
  var includeRefs = [];
  var confVars = [];
  var confVarsById = Object.create(null);
  var confKeys = [];
  var confKeysByName = Object.create(null);
  var confVarRe = /<CONF_VAR\b[^>]*\bid="([^"]+)"[^>]*\bvalue="([^"]*)"[^>]*\/?>/g;
  var confKeyRe = /<CONF_KEY\b[^>]*\/?>/g;
  var includeRe = /<INCLUDE\b[^>]*\bid="([^"]+)"[^>]*\/?>/g;
  var moduleRe = /<MODULE\b[^>]*>([\s\S]*?)<\/MODULE>/g;
  var match;

  while ((match = confVarRe.exec(text)) !== null) {
    var confValueStart = match.index + match[0].lastIndexOf(match[2]);
    var confVar = {
      id: match[1],
      value: match[2],
      rawValue: match[2],
      isLiteral: true,
      start: confValueStart,
      end: confValueStart + match[2].length
    };

    confVars.push(confVar);
    if (!confVarsById[confVar.id]) {
      confVarsById[confVar.id] = [];
    }
    confVarsById[confVar.id].push(confVar);

    if (match[1] === 'includes' || match[1] === 'layers') {
      includeRefs.push({
        id: match[2],
        kind: match[1],
        start: confValueStart,
        end: confValueStart + match[2].length
      });
    }
  }

  while ((match = confKeyRe.exec(text)) !== null) {
    var confKeyAttrs = parseTagAttributes(match[0], match.index);
    if (!confKeyAttrs.name) {
      continue;
    }

    var confKey = {
      name: confKeyAttrs.name.value,
      start: confKeyAttrs.name.start,
      end: confKeyAttrs.name.end,
      select: confKeyAttrs.select ? confKeyAttrs.select.value : '',
      defaultValue: confKeyAttrs.default ? confKeyAttrs.default.value : '',
      preview: 'CONF_KEY ' + confKeyAttrs.name.value
    };

    confKeys.push(confKey);
    if (!confKeysByName[confKey.name]) {
      confKeysByName[confKey.name] = [];
    }
    confKeysByName[confKey.name].push(confKey);
  }

  while ((match = includeRe.exec(text)) !== null) {
    var includeValueStart = match.index + match[0].indexOf('"') + 1;
    includeRefs.push({
      id: match[1],
      kind: 'include',
      start: includeValueStart,
      end: includeValueStart + match[1].length
    });
  }

  while ((match = moduleRe.exec(text)) !== null) {
    var blockStart = match.index;
    var blockText = match[0];
    var attrList = [];
    var varRe = /<VAR\b[^>]*\/?>/g;
    var varMatch;

    while ((varMatch = varRe.exec(blockText)) !== null) {
      var attrs = parseTagAttributes(varMatch[0], blockStart + varMatch.index);
      if (!attrs.id) {
        continue;
      }

      var sourceAttr = attrs.value || attrs.get || attrs.key || null;
      if (!sourceAttr) {
        continue;
      }

      attrList.push({
        id: attrs.id.value,
        value: sourceAttr.value,
        rawValue: sourceAttr.value,
        isLiteral: true,
        start: sourceAttr.start,
        end: sourceAttr.end,
        nameStart: attrs.id.start,
        nameEnd: attrs.id.end,
        sourceAttrKind: attrs.value ? 'value' : (attrs.get ? 'get' : 'key')
      });
    }

    blocks.push(buildModuleBlock(attrList, {
      start: blockStart,
      end: blockStart + blockText.length,
      sourceKind: 'type'
    }));
  }

  return {
    blocks: blocks,
    includeRefs: includeRefs,
    confVars: confVars,
    confVarsById: confVarsById,
    confKeys: confKeys,
    confKeysByName: confKeysByName
  };
}

function parseQuotedToken(text, index) {
  var quote = text[index];
  var i = index + 1;

  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      return {
        value: text.slice(index + 1, i),
        start: index + 1,
        end: i,
        nextIndex: i + 1
      };
    }
    i += 1;
  }

  return null;
}

function skipSpaceAndComments(text, index, limit) {
  var i = index;
  var max = typeof limit === 'number' ? limit : text.length;

  while (i < max) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    if (text[i] === '#') {
      while (i < max && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    break;
  }

  return i;
}

function findMatching(text, openIndex, openChar, closeChar) {
  var depth = 0;
  var i = openIndex;
  var quote = '';

  while (i < text.length) {
    var ch = text[i];

    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = '';
      }
      i += 1;
      continue;
    }

    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '\'' || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }

    i += 1;
  }

  return -1;
}

function isLineCommented(text, offset) {
  var lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1));
  var prefix = text.slice(lineStart === -1 ? 0 : lineStart + 1, offset);
  return /^\s*#/.test(prefix);
}

function consumePerlExpression(text, index, stopChars, limit) {
  var max = typeof limit === 'number' ? limit : text.length;
  var start = skipSpaceAndComments(text, index, max);
  var stopMap = Object.create(null);
  var i;
  var quote = '';
  var parenDepth = 0;
  var braceDepth = 0;
  var bracketDepth = 0;

  for (i = 0; i < stopChars.length; i += 1) {
    stopMap[stopChars[i]] = true;
  }

  if (start >= max) {
    return {
      rawValue: '',
      value: '',
      isLiteral: false,
      start: start,
      end: start,
      nextIndex: start
    };
  }

  if (text[start] === '\'' || text[start] === '"') {
    var quoted = parseQuotedToken(text, start);
    if (quoted) {
      return {
        rawValue: text.slice(start, quoted.nextIndex),
        value: quoted.value,
        isLiteral: true,
        start: quoted.start,
        end: quoted.end,
        nextIndex: quoted.nextIndex
      };
    }
  }

  i = start;
  while (i < max) {
    var ch = text[i];

    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = '';
      }
      i += 1;
      continue;
    }

    if (ch === '#') {
      while (i < max && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '\'' || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (parenDepth === 0 && stopMap[ch] && braceDepth === 0 && bracketDepth === 0) {
        break;
      }
      parenDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (braceDepth === 0 && stopMap[ch] && parenDepth === 0 && bracketDepth === 0) {
        break;
      }
      braceDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === '[') {
      bracketDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ']') {
      bracketDepth -= 1;
      i += 1;
      continue;
    }
    if (stopMap[ch] && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      break;
    }

    i += 1;
  }

  var end = i;
  while (end > start && /\s/.test(text[end - 1])) {
    end -= 1;
  }

  return {
    rawValue: text.slice(start, end),
    value: text.slice(start, end).trim(),
    isLiteral: false,
    start: start,
    end: end,
    nextIndex: i
  };
}

function parseTomahawkCallBlocks(text) {
  var blocks = [];
  var callRe = /Tomahawk::(tplmodule|module)\s*\(/g;
  var match;

  while ((match = callRe.exec(text)) !== null) {
    var openIndex = match.index + match[0].lastIndexOf('(');
    if (isLineCommented(text, match.index)) {
      continue;
    }

    var closeIndex = findMatching(text, openIndex, '(', ')');
    if (closeIndex === -1) {
      continue;
    }

    blocks.push(parseTomahawkCall(text, match[1], match.index, openIndex, closeIndex));
    callRe.lastIndex = closeIndex + 1;
  }

  return blocks;
}

function parseTomahawkCall(text, callType, callStart, openIndex, closeIndex) {
  var attrList = [];
  var i = openIndex + 1;

  while (i < closeIndex) {
    i = skipSpaceAndComments(text, i, closeIndex);
    if (i >= closeIndex) {
      break;
    }

    if (text[i] === ',') {
      i += 1;
      continue;
    }

    if (text[i] !== '\'' && text[i] !== '"') {
      i += 1;
      continue;
    }

    var keyToken = parseQuotedToken(text, i);
    if (!keyToken) {
      break;
    }

    i = skipSpaceAndComments(text, keyToken.nextIndex, closeIndex);
    if (text.slice(i, i + 2) !== '=>') {
      i = keyToken.nextIndex;
      continue;
    }

    i += 2;
    var valueInfo = consumePerlExpression(text, i, [',', ')'], closeIndex);
    attrList.push({
      id: keyToken.value,
      value: valueInfo.value,
      rawValue: valueInfo.rawValue,
      isLiteral: valueInfo.isLiteral,
      start: valueInfo.start,
      end: valueInfo.end,
      nameStart: keyToken.start,
      nameEnd: keyToken.end
    });

    i = valueInfo.nextIndex;
    if (text[i] === ',') {
      i += 1;
    }
  }

  return buildModuleBlock(attrList, {
    start: callStart,
    end: closeIndex + 1,
    callType: callType,
    sourceKind: 'perl'
  });
}

function extractBraceKeySegments(chainText, baseOffset) {
  var result = [];
  var re = /\{\s*(["'])([^"']+)\1\s*\}/g;
  var match;

  while ((match = re.exec(chainText)) !== null) {
    var valueStart = baseOffset + match.index + match[0].lastIndexOf(match[2]);
    result.push({
      value: match[2],
      start: valueStart,
      end: valueStart + match[2].length
    });
  }

  return result;
}

function parsePerlReferences(text) {
  var envRefs = [];
  var tplVariableWrites = [];
  var tomSetupRefs = [];
  var envRe = /\$env\{\s*(["'])([^"']+)\1\s*\}/g;
  var tplVarRe = /\$TPL(?:->)?\{\s*["']variables["']\s*\}(?:->)?\{\s*["']([^"']+)["']\s*\}/g;
  var tomSetupRe = /\$tom::setup((?:\s*\{\s*["'][^"']+["']\s*\})+)/g;
  var match;

  while ((match = envRe.exec(text)) !== null) {
    envRefs.push({
      key: match[2],
      start: match.index,
      end: match.index + match[0].length
    });
  }

  while ((match = tplVarRe.exec(text)) !== null) {
    tplVariableWrites.push({
      key: match[1],
      start: match.index,
      end: match.index + match[0].length
    });
  }

  while ((match = tomSetupRe.exec(text)) !== null) {
    var segments = extractBraceKeySegments(match[1], match.index + match[0].indexOf(match[1]));
    if (!segments.length) {
      continue;
    }
    var last = segments[segments.length - 1];
    tomSetupRefs.push({
      key: segments.map(function (segment) { return segment.value; }).join('.'),
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return {
    envRefs: uniqueKeyRefs(envRefs),
    tplVariableWrites: uniqueKeyRefs(tplVariableWrites),
    tomSetupRefs: uniqueKeyRefs(tomSetupRefs),
    callBlocks: parseTomahawkCallBlocks(text)
  };
}

function parsePerlHashPairs(text, startIndex, endIndex, prefix, results) {
  var i = startIndex;

  while (i < endIndex) {
    i = skipSpaceAndComments(text, i, endIndex);
    if (i >= endIndex) {
      break;
    }
    if (text[i] === ',' || text[i] === ')' || text[i] === '}') {
      i += 1;
      continue;
    }
    if (text[i] !== '\'' && text[i] !== '"') {
      i += 1;
      continue;
    }

    var keyToken = parseQuotedToken(text, i);
    if (!keyToken) {
      break;
    }

    i = skipSpaceAndComments(text, keyToken.nextIndex, endIndex);
    if (text.slice(i, i + 2) !== '=>') {
      i = keyToken.nextIndex;
      continue;
    }

    i += 2;
    i = skipSpaceAndComments(text, i, endIndex);

    var keyPath = prefix.concat([keyToken.value]).join('.');
    results.push({
      key: keyPath,
      start: keyToken.start,
      end: keyToken.end,
      preview: previewLine(text, keyToken.start)
    });

    if (text[i] === '{') {
      var nestedEnd = findMatching(text, i, '{', '}');
      if (nestedEnd === -1) {
        break;
      }
      parsePerlHashPairs(text, i + 1, nestedEnd, prefix.concat([keyToken.value]), results);
      i = nestedEnd + 1;
      continue;
    }

    var valueInfo = consumePerlExpression(text, i, [',', ')', '}'], endIndex);
    i = valueInfo.nextIndex;
    if (text[i] === ',') {
      i += 1;
    }
  }
}

function parseConfigReferences(text) {
  var assignments = [];
  var collected = [];
  var seen = Object.create(null);
  var match;
  var directRe = /\$tom::setup((?:\s*\{\s*["'][^"']+["']\s*\})+)\s*=/g;
  var initRe = /%tom::setup\s*=\s*\(/g;

  function pushAssignment(item) {
    var key = item.key + ':' + item.start + ':' + item.end;
    if (seen[key]) {
      return;
    }
    seen[key] = true;
    collected.push(item);
  }

  while ((match = directRe.exec(text)) !== null) {
    var segments = extractBraceKeySegments(match[1], match.index + match[0].indexOf(match[1]));
    if (!segments.length) {
      continue;
    }
    var last = segments[segments.length - 1];
    pushAssignment({
      key: segments.map(function (segment) { return segment.value; }).join('.'),
      start: last.start,
      end: last.end,
      preview: previewLine(text, last.start)
    });
  }

  while ((match = initRe.exec(text)) !== null) {
    var openIndex = match.index + match[0].lastIndexOf('(');
    var closeIndex = findMatching(text, openIndex, '(', ')');
    if (closeIndex === -1) {
      continue;
    }
    parsePerlHashPairs(text, openIndex + 1, closeIndex, [], assignments);
    initRe.lastIndex = closeIndex + 1;
  }

  assignments.forEach(function (item) {
    pushAssignment(item);
  });

  collected.sort(function (left, right) {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.key.localeCompare(right.key);
  });

  var assignmentsByKey = Object.create(null);
  collected.forEach(function (item) {
    if (!assignmentsByKey[item.key]) {
      assignmentsByKey[item.key] = [];
    }
    assignmentsByKey[item.key].push(item);
  });

  return {
    assignments: collected,
    assignmentsByKey: assignmentsByKey
  };
}

function safeRealPath(absPath) {
  try {
    return fs.realpathSync(absPath);
  } catch (error) {
    return absPath;
  }
}

function walkFiles(rootPath, currentPath, result, matchFile, visitedDirs, visitedFiles) {
  var realCurrent = safeRealPath(currentPath);
  var entries;
  var i;

  if (visitedDirs[realCurrent]) {
    return;
  }
  visitedDirs[realCurrent] = true;

  try {
    entries = fs.readdirSync(currentPath);
  } catch (error) {
    return;
  }

  for (i = 0; i < entries.length; i += 1) {
    var entryName = entries[i];
    var absPath = path.join(currentPath, entryName);
    var stat;
    var lstat;

    try {
      lstat = fs.lstatSync(absPath);
      stat = lstat.isSymbolicLink() ? fs.statSync(absPath) : lstat;
    } catch (error) {
      continue;
    }

    if (stat.isDirectory()) {
      if (SKIP_DIRS[entryName]) {
        continue;
      }
      walkFiles(rootPath, absPath, result, matchFile, visitedDirs, visitedFiles);
      continue;
    }

    if (!stat.isFile() || !matchFile(absPath, entryName)) {
      continue;
    }

    var realFile = safeRealPath(absPath);
    if (visitedFiles[realFile]) {
      continue;
    }
    visitedFiles[realFile] = true;
    result.push(absPath);
  }
}

function walkRelevantFiles(rootPath, currentPath, result, visitedDirs, visitedFiles) {
  walkFiles(rootPath, currentPath, result, function (absPath, entryName) {
    return RELEVANT_FILE_RE.test(entryName) || RELEVANT_FILE_RE.test(relativePath(rootPath, absPath));
  }, visitedDirs, visitedFiles);
}

function walkConfigFiles(rootPath, currentPath, result, visitedDirs, visitedFiles) {
  walkFiles(rootPath, currentPath, result, function (absPath) {
    return CONFIG_FILE_RE.test(relativePath(rootPath, absPath));
  }, visitedDirs, visitedFiles);
}

function getLiteralAttrValue(block, attrId) {
  var attr = block && block.attrsById ? block.attrsById[attrId] : null;
  if (!attr) {
    return '';
  }
  if (attr.isLiteral === false) {
    return '';
  }
  return attr.value || '';
}

function isMetaAttrId(attrId) {
  return /^-/.test(String(attrId || ''));
}

function buildIncomingEnvPreview(attr) {
  if (!attr) {
    return '';
  }

  if (attr.sourceAttrKind === 'get') {
    return 'get ' + String(attr.value || '');
  }

  if (attr.sourceAttrKind === 'key') {
    return 'key ' + String(attr.value || '');
  }

  return attr.id + ' = ' + previewText(attr.rawValue || attr.value, 80);
}

function WorkspaceIndex(rootPath) {
  this.rootPath = rootPath;
  this.fileEntries = [];
  this.fileEntriesByRelPath = Object.create(null);
  this.filesByBasename = Object.create(null);
  this.l10nFiles = [];
  this.xhtmlFiles = [];
  this.templateFiles = [];
  this.typeFiles = [];
  this.perlFiles = [];
  this.configFiles = [];
  this.configEntriesByRelPath = Object.create(null);
  this.callSites = [];
  this.incomingEnvByTargetRelPath = Object.create(null);
  this.templateTargetsByModuleRelPath = Object.create(null);
  this.templateVarsByTemplateRelPath = Object.create(null);
}

WorkspaceIndex.prototype.rebuild = function rebuild() {
  var files = [];
  var configs = [];
  this.fileEntries = [];
  this.fileEntriesByRelPath = Object.create(null);
  this.filesByBasename = Object.create(null);
  this.l10nFiles = [];
  this.xhtmlFiles = [];
  this.templateFiles = [];
  this.typeFiles = [];
  this.perlFiles = [];
  this.configFiles = [];
  this.configEntriesByRelPath = Object.create(null);
  this.callSites = [];
  this.incomingEnvByTargetRelPath = Object.create(null);
  this.templateTargetsByModuleRelPath = Object.create(null);
  this.templateVarsByTemplateRelPath = Object.create(null);

  walkRelevantFiles(this.rootPath, this.rootPath, files, Object.create(null), Object.create(null));
  walkConfigFiles(this.rootPath, this.rootPath, configs, Object.create(null), Object.create(null));

  var i;
  for (i = 0; i < files.length; i += 1) {
    this._addFile(files[i]);
  }
  for (i = 0; i < configs.length; i += 1) {
    this._addConfigFile(configs[i]);
  }

  this._buildCrossReferences();
};

WorkspaceIndex.prototype._addFile = function _addFile(absPath) {
  var relPath = relativePath(this.rootPath, absPath);
  var kind = detectFileKind(relPath);
  var entry = {
    absPath: absPath,
    relPath: relPath,
    baseName: path.basename(relPath),
    kind: kind,
    dirRole: getDirectoryRole(relPath),
    scopeInfo: getScopeInfo(relPath),
    text: '',
    templateInfo: null,
    l10nInfo: null,
    typeInfo: null,
    perlInfo: null
  };

  try {
    entry.text = fs.readFileSync(absPath, 'utf8');
  } catch (error) {
    entry.text = '';
  }

  if (kind === 'tpl' || kind === 'xhtml' || kind === 'body') {
    entry.templateInfo = parseTemplateReferences(entry.text);
    this.templateFiles.push(entry);
  }
  if (kind === 'xhtml') {
    this.xhtmlFiles.push(entry);
  }
  if (kind === 'l10n') {
    entry.l10nInfo = parseL10nReferences(entry.text);
    this.l10nFiles.push(entry);
  }
  if (kind === 'type') {
    entry.typeInfo = parseTypeReferences(entry.text);
    this.typeFiles.push(entry);
  }
  if (kind === 'mdl' || kind === 'smdl') {
    entry.perlInfo = parsePerlReferences(entry.text);
    this.perlFiles.push(entry);
  }

  this.fileEntries.push(entry);
  this.fileEntriesByRelPath[entry.relPath] = entry;

  if (!this.filesByBasename[entry.baseName]) {
    this.filesByBasename[entry.baseName] = [];
  }
  this.filesByBasename[entry.baseName].push(entry);
};

WorkspaceIndex.prototype._addConfigFile = function _addConfigFile(absPath) {
  var relPath = relativePath(this.rootPath, absPath);
  var text = '';

  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (error) {
    text = '';
  }

  var entry = {
    absPath: absPath,
    relPath: relPath,
    baseName: path.basename(relPath),
    text: text,
    configInfo: parseConfigReferences(text)
  };

  this.configFiles.push(entry);
  this.configEntriesByRelPath[relPath] = entry;
};

WorkspaceIndex.prototype._pushIncomingEnv = function _pushIncomingEnv(targetRelPath, item) {
  if (!this.incomingEnvByTargetRelPath[targetRelPath]) {
    this.incomingEnvByTargetRelPath[targetRelPath] = [];
  }
  this.incomingEnvByTargetRelPath[targetRelPath].push(item);
};

WorkspaceIndex.prototype._pushTemplateTarget = function _pushTemplateTarget(moduleRelPath, item) {
  if (!this.templateTargetsByModuleRelPath[moduleRelPath]) {
    this.templateTargetsByModuleRelPath[moduleRelPath] = [];
  }
  this.templateTargetsByModuleRelPath[moduleRelPath].push(item);
};

WorkspaceIndex.prototype._pushTemplateVar = function _pushTemplateVar(templateRelPath, item) {
  if (!this.templateVarsByTemplateRelPath[templateRelPath]) {
    this.templateVarsByTemplateRelPath[templateRelPath] = [];
  }
  this.templateVarsByTemplateRelPath[templateRelPath].push(item);
};

WorkspaceIndex.prototype._buildCrossReferences = function _buildCrossReferences() {
  var self = this;
  var sources = this.typeFiles.concat(this.perlFiles);

  sources.forEach(function (entry) {
    var blocks = entry.typeInfo ? entry.typeInfo.blocks : (entry.perlInfo ? entry.perlInfo.callBlocks : []);
    blocks.forEach(function (block) {
      var resolved = self.resolveModuleBlockTargets(block, entry.relPath);
      var envAttrs = block.attrList.filter(function (attr) {
        return !isMetaAttrId(attr.id);
      });
      var incomingEnvItems = [];

      self.callSites.push({
        sourceEntry: entry,
        block: block,
        resolved: resolved
      });

      envAttrs.forEach(function (attr) {
        if (entry.typeInfo && attr.sourceAttrKind === 'key') {
          var confKeyTargets = self.resolveConfKeyTargets(attr.value, entry.relPath);
          if (confKeyTargets.length) {
            confKeyTargets.forEach(function (result) {
              incomingEnvItems.push({
                key: attr.id,
                entry: result.entry,
                start: result.start,
                end: result.end,
                preview: result.preview || ('CONF_KEY ' + attr.value)
              });
            });
            return;
          }
        }

        incomingEnvItems.push({
          key: attr.id,
          entry: entry,
          start: attr.start,
          end: attr.end,
          preview: buildIncomingEnvPreview(attr)
        });
      });

      resolved.moduleEntries.forEach(function (target) {
        incomingEnvItems.forEach(function (attr) {
          self._pushIncomingEnv(target.entry.relPath, {
            key: attr.key,
            entry: attr.entry,
            start: attr.start,
            end: attr.end,
            preview: attr.preview
          });
        });
      });

      resolved.templateEntries.forEach(function (target) {
        incomingEnvItems.forEach(function (attr) {
          self._pushIncomingEnv(target.entry.relPath, {
            key: attr.key,
            entry: attr.entry,
            start: attr.start,
            end: attr.end,
            preview: attr.preview
          });
        });
      });

      resolved.moduleEntries.forEach(function (moduleTarget) {
        var tplVars = moduleTarget.entry.perlInfo ? moduleTarget.entry.perlInfo.tplVariableWrites : [];

        resolved.templateEntries.forEach(function (templateTarget) {
          self._pushTemplateTarget(moduleTarget.entry.relPath, {
            entry: templateTarget.entry,
            start: 0,
            end: 0,
            preview: templateTarget.entry.relPath
          });

          tplVars.forEach(function (tplVar) {
            self._pushTemplateVar(templateTarget.entry.relPath, {
              key: tplVar.key,
              entry: moduleTarget.entry,
              start: tplVar.start,
              end: tplVar.end,
              preview: tplVar.key
            });
          });
        });
      });
    });
  });
};

WorkspaceIndex.prototype.getEntry = function getEntry(relPath) {
  return this.fileEntriesByRelPath[normalizeSlashes(relPath)] || null;
};

WorkspaceIndex.prototype._candidatePath = function _candidatePath(root, directoryName, baseName) {
  if (!root) {
    return directoryName + '/' + baseName;
  }
  return root + '/' + directoryName + '/' + baseName;
};

WorkspaceIndex.prototype._resolveExactCandidates = function _resolveExactCandidates(candidatePaths) {
  var results = [];
  var i;
  for (i = 0; i < candidatePaths.length; i += 1) {
    var entry = this.fileEntriesByRelPath[candidatePaths[i]];
    if (entry) {
      results.push({
        entry: entry,
        reason: 'exact'
      });
    }
  }
  return uniqueFileResults(results);
};

WorkspaceIndex.prototype._scoreScope = function _scoreScope(relPath, roots) {
  var i;
  for (i = 0; i < roots.length; i += 1) {
    if (startsWithSegment(relPath, roots[i])) {
      return i;
    }
  }
  return roots.length + 1;
};

WorkspaceIndex.prototype._sortScopedEntries = function _sortScopedEntries(entries, roots) {
  var self = this;
  return entries.slice().sort(function (left, right) {
    var leftScore = self._scoreScope(left.entry.relPath, roots);
    var rightScore = self._scoreScope(right.entry.relPath, roots);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return left.entry.relPath.localeCompare(right.entry.relPath);
  });
};

WorkspaceIndex.prototype._fallbackByBasename = function _fallbackByBasename(basenames, roots, directoryName) {
  var results = [];
  var self = this;

  basenames.forEach(function (baseName) {
    var entries = self.filesByBasename[baseName] || [];
    entries.forEach(function (entry) {
      if (entry.relPath.indexOf('/' + directoryName + '/') === -1 && entry.relPath.indexOf(directoryName + '/') !== 0) {
        return;
      }
      results.push({
        entry: entry,
        reason: 'basename'
      });
    });
  });

  return uniqueFileResults(this._sortScopedEntries(results, roots));
};

WorkspaceIndex.prototype._fallbackByPattern = function _fallbackByPattern(predicate, roots) {
  var results = [];
  var i;
  for (i = 0; i < this.fileEntries.length; i += 1) {
    var entry = this.fileEntries[i];
    if (predicate(entry)) {
      results.push({
        entry: entry,
        reason: 'pattern'
      });
    }
  }
  return uniqueFileResults(this._sortScopedEntries(results, roots));
};

WorkspaceIndex.prototype._findTmpTagsInEntries = function _findTmpTagsInEntries(entries, tmpId, reason) {
  var results = [];

  entries.forEach(function (item) {
    var entry = item.entry || item;
    if (!entry || !entry.templateInfo) {
      return;
    }
    entry.templateInfo.tmpTags.forEach(function (tmpTag) {
      if (tmpTag.id === tmpId) {
        results.push({
          entry: entry,
          start: tmpTag.start,
          end: tmpTag.end,
          reason: reason || 'tmp'
        });
      }
    });
  });

  return uniqueFileResults(results);
};

WorkspaceIndex.prototype.resolveIncludeTargets = function resolveIncludeTargets(includeId, contextRelPath) {
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, 'auto');
  var candidateBasenames = [
    includeId + '.inc',
    includeId + '.cml_gen',
    includeId + '.cml_type'
  ];
  var candidatePaths = [];
  var i;

  for (i = 0; i < roots.length; i += 1) {
    var root = roots[i];
    candidateBasenames.forEach(function (baseName) {
      candidatePaths.push(root ? root + '/_type/' + baseName : '_type/' + baseName);
    });
  }

  var exact = this._resolveExactCandidates(candidatePaths);
  if (exact.length) {
    return exact;
  }

  return this._fallbackByPattern(function (entry) {
    return entry.kind === 'type' &&
      (entry.baseName === includeId + '.inc' ||
        entry.baseName === includeId + '.cml_gen' ||
        entry.baseName === includeId + '.cml_type');
  }, roots);
};

WorkspaceIndex.prototype._collectIncludedTypeEntries = function _collectIncludedTypeEntries(relPath, visited) {
  var entry = this.getEntry(relPath);
  var results = [];
  var self = this;

  if (!entry || !entry.typeInfo) {
    return results;
  }

  visited = visited || Object.create(null);
  if (visited[entry.relPath]) {
    return results;
  }
  visited[entry.relPath] = true;

  entry.typeInfo.includeRefs.forEach(function (includeRef) {
    self.resolveIncludeTargets(includeRef.id, entry.relPath).forEach(function (target) {
      if (!target.entry || !target.entry.typeInfo || visited[target.entry.relPath]) {
        return;
      }
      results.push(target.entry);
      Array.prototype.push.apply(results, self._collectIncludedTypeEntries(target.entry.relPath, visited));
    });
  });

  return uniqueEntries(results);
};

WorkspaceIndex.prototype.resolveConfKeyTargets = function resolveConfKeyTargets(keyName, contextRelPath) {
  var results = [];
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, 'auto');
  var self = this;

  function appendEntry(entry, reason) {
    if (!entry || !entry.typeInfo) {
      return;
    }

    (entry.typeInfo.confKeysByName[keyName] || []).forEach(function (confKey) {
      results.push({
        entry: entry,
        start: confKey.start,
        end: confKey.end,
        preview: confKey.preview,
        reason: reason
      });
    });
  }

  appendEntry(this.getEntry(contextRelPath), 'same-type');
  this._collectIncludedTypeEntries(contextRelPath).forEach(function (entry) {
    appendEntry(entry, 'included-type');
  });

  if (results.length) {
    return uniqueFileResults(results);
  }

  this._fallbackByPattern(function (entry) {
    return entry.kind === 'type' &&
      !!entry.typeInfo &&
      !!entry.typeInfo.confKeysByName[keyName];
  }, roots).forEach(function (item) {
    appendEntry(item.entry, 'scoped-type');
  });

  return uniqueFileResults(results);
};

WorkspaceIndex.prototype.resolveModuleBlockTargets = function resolveModuleBlockTargets(block, contextRelPath) {
  var spec = block.spec || block;
  var prefix = String(
    getLiteralAttrValue(block, '-addon') ||
    getLiteralAttrValue(block, '-category') ||
    spec.addon ||
    spec.category ||
    ''
  ).replace(/^a/i, '');
  var moduleType = String(getLiteralAttrValue(block, '-type') || spec.type || '').toLowerCase();
  var name = String(getLiteralAttrValue(block, '-name') || spec.name || '');
  var version = String(getLiteralAttrValue(block, '-version') || spec.version || '0');
  var templateName = String(getLiteralAttrValue(block, '-tpl') || spec.tpl || 'default');
  var scopeInfo = getScopeInfo(contextRelPath);
  var moduleRoots = getRootsForLevel(scopeInfo, getLiteralAttrValue(block, '-level') || spec.level || 'auto');
  var templateRoots = getRootsForLevel(scopeInfo, getLiteralAttrValue(block, '-tpl_level') || spec.tplLevel || getLiteralAttrValue(block, '-level') || spec.level || 'auto');
  var moduleEntries = [];
  var templateEntries = [];
  var moduleBaseName;
  var templateBaseName;
  var candidatePaths = [];
  var i;

  if (!prefix || !name || !moduleType) {
    return {
      spec: spec,
      moduleEntries: [],
      templateEntries: []
    };
  }

  if (moduleType === 'mdl' || moduleType === 'smdl') {
    moduleBaseName = prefix + '-' + name + '.' + version + (moduleType === 'smdl' ? '.smdl' : '.mdl');
    for (i = 0; i < moduleRoots.length; i += 1) {
      candidatePaths.push(this._candidatePath(moduleRoots[i], '_mdl', moduleBaseName));
    }
    moduleEntries = this._resolveExactCandidates(candidatePaths);
    if (!moduleEntries.length) {
      moduleEntries = this._fallbackByBasename([moduleBaseName], moduleRoots, '_mdl');
    }

    candidatePaths = [];
    templateBaseName = prefix + '-' + name + '.' + version + '.' + templateName + '.tpl';
    for (i = 0; i < templateRoots.length; i += 1) {
      candidatePaths.push(this._candidatePath(templateRoots[i], '_mdl', templateBaseName));
    }
    templateEntries = this._resolveExactCandidates(candidatePaths);
    if (!templateEntries.length) {
      templateEntries = this._fallbackByBasename([templateBaseName], templateRoots, '_mdl');
    }
  } else if (moduleType === 'tpl') {
    templateBaseName = prefix + '-' + name + '.' + version + '.' + templateName + '.tpl';
    for (i = 0; i < templateRoots.length; i += 1) {
      candidatePaths.push(this._candidatePath(templateRoots[i], '_mdl', templateBaseName));
    }
    templateEntries = this._resolveExactCandidates(candidatePaths);
    if (!templateEntries.length) {
      templateEntries = this._fallbackByBasename([templateBaseName], templateRoots, '_mdl');
    }
  }

  return {
    spec: spec,
    moduleEntries: moduleEntries,
    templateEntries: templateEntries
  };
};

WorkspaceIndex.prototype._collectTypeConfValuesFromEntry = function _collectTypeConfValuesFromEntry(entry, confId, visited) {
  var self = this;
  var results = [];

  if (!entry || !entry.typeInfo) {
    return results;
  }

  visited = visited || Object.create(null);
  if (visited[entry.relPath]) {
    return results;
  }
  visited[entry.relPath] = true;

  (entry.typeInfo.confVarsById[confId] || []).forEach(function (item) {
    results.push(item.value);
  });

  entry.typeInfo.includeRefs.forEach(function (includeRef) {
    self.resolveIncludeTargets(includeRef.id, entry.relPath).forEach(function (target) {
      Array.prototype.push.apply(results, self._collectTypeConfValuesFromEntry(target.entry, confId, visited));
    });
  });

  return uniqueStrings(results);
};

WorkspaceIndex.prototype.resolveLayoutTemplateTargets = function resolveLayoutTemplateTargets(contextRelPath) {
  var entry = this.getEntry(contextRelPath);
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, 'auto');
  var self = this;
  var bodyNames = this._collectTypeConfValuesFromEntry(entry, 'body', Object.create(null));
  var results = [];

  bodyNames.forEach(function (bodyName) {
    var exactPaths = [];
    var i;
    for (i = 0; i < roots.length; i += 1) {
      exactPaths.push(self._candidatePath(roots[i], '_dsgn', bodyName + '.body'));
    }

    var exact = self._resolveExactCandidates(exactPaths);
    if (exact.length) {
      Array.prototype.push.apply(results, exact);
      return;
    }

    Array.prototype.push.apply(results, self._fallbackByBasename([bodyName + '.body'], roots, '_dsgn'));
  });

  return uniqueFileResults(results);
};

WorkspaceIndex.prototype.resolveParentTemplateTargets = function resolveParentTemplateTargets(block, contextRelPath, siblingBlocks) {
  var entry = this.getEntry(contextRelPath);
  var blocks = siblingBlocks || (entry && entry.typeInfo ? entry.typeInfo.blocks : (entry && entry.perlInfo ? entry.perlInfo.callBlocks : []));
  var currentIndex = -1;
  var i;

  for (i = 0; i < blocks.length; i += 1) {
    if (blocks[i] === block || (blocks[i].start === block.start && blocks[i].end === block.end)) {
      currentIndex = i;
      break;
    }
  }

  if (currentIndex === -1) {
    currentIndex = blocks.length;
  }

  for (i = currentIndex - 1; i >= 0; i -= 1) {
    var resolved = this.resolveModuleBlockTargets(blocks[i], contextRelPath);
    if (resolved.templateEntries.length) {
      return resolved.templateEntries;
    }
  }

  if (entry && entry.kind === 'type') {
    return this.resolveLayoutTemplateTargets(contextRelPath);
  }

  return [];
};

WorkspaceIndex.prototype.resolveTmpTargetsFromBlock = function resolveTmpTargetsFromBlock(block, contextRelPath, siblingBlocks) {
  var tmpId = getLiteralAttrValue(block, '-TMP');
  if (!tmpId) {
    return [];
  }

  var parentTargets = this.resolveParentTemplateTargets(block, contextRelPath, siblingBlocks);
  if (parentTargets.length) {
    return this._findTmpTagsInEntries(parentTargets, tmpId, 'parent-tmp');
  }

  return this.resolveTmpTargets(tmpId, contextRelPath);
};

WorkspaceIndex.prototype.resolveTypeAttributeTargets = function resolveTypeAttributeTargets(block, attrId, contextRelPath, siblingBlocks) {
  var resolved = this.resolveModuleBlockTargets(block, contextRelPath);
  var spec = resolved.spec;
  var moduleType = String(spec.type || '').toLowerCase();

  if (attrId === '-tpl') {
    return resolved.templateEntries;
  }

  if (attrId === '-TMP') {
    return this.resolveTmpTargetsFromBlock(block, contextRelPath, siblingBlocks);
  }

  if (attrId === '-name') {
    if (moduleType === 'mdl' || moduleType === 'smdl') {
      return resolved.moduleEntries;
    }
    return [];
  }

  return [];
};

WorkspaceIndex.prototype.resolveTmpTargets = function resolveTmpTargets(tmpId, contextRelPath) {
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, 'auto');

  if (!tmpId) {
    return [];
  }

  return this._fallbackByPattern(function (entry) {
    if (!(entry.kind === 'tpl' || entry.kind === 'xhtml' || entry.kind === 'body') || !entry.templateInfo) {
      return false;
    }
    return entry.templateInfo.tmpTags.some(function (tmpTag) {
      return tmpTag.id === tmpId;
    });
  }, roots).map(function (item) {
    var tmpTag = item.entry.templateInfo.tmpTags.filter(function (candidate) {
      return candidate.id === tmpId;
    })[0];
    return {
      entry: item.entry,
      start: tmpTag ? tmpTag.start : 0,
      end: tmpTag ? tmpTag.end : 0,
      reason: 'tmp'
    };
  });
};

WorkspaceIndex.prototype.resolveExtendTargets = function resolveExtendTargets(ref, contextRelPath) {
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, ref.level || 'auto');
  var currentBaseName = path.basename(contextRelPath);
  var currentPrefix = getLeadingNumericPrefix(currentBaseName);
  var exactBasenames = [];
  var exactResults;

  if (ref.name) {
    exactBasenames.push(ref.name + '.xhtml.tpl');
    if (currentPrefix) {
      exactBasenames.push('a' + currentPrefix + '-' + ref.name + '.xhtml.tpl');
    }
  }
  if (ref.addon) {
    exactBasenames.push(ref.addon + '.xhtml.tpl');
    exactBasenames.push(ref.addon + '-default.xhtml.tpl');
  }

  exactResults = this._fallbackByBasename(exactBasenames, roots, '_dsgn');
  if (exactResults.length) {
    return exactResults;
  }

  return this._fallbackByPattern(function (entry) {
    if (entry.kind !== 'xhtml') {
      return false;
    }
    if (ref.name && entry.baseName === ref.name + '.xhtml.tpl') {
      return true;
    }
    if (ref.name && entry.baseName.slice(-('-' + ref.name + '.xhtml.tpl').length) === '-' + ref.name + '.xhtml.tpl') {
      return true;
    }
    if (ref.addon && entry.baseName.indexOf(ref.addon + '-') === 0) {
      return true;
    }
    return false;
  }, roots);
};

WorkspaceIndex.prototype._collectExtendedFiles = function _collectExtendedFiles(relPath, visited) {
  var entry = this.getEntry(relPath);
  var results = [];
  var self = this;

  if (!entry || !entry.templateInfo) {
    return results;
  }

  visited = visited || Object.create(null);
  if (visited[entry.relPath]) {
    return results;
  }
  visited[entry.relPath] = true;

  entry.templateInfo.headerExtendsRefs.forEach(function (extendRef) {
    var targets = self.resolveExtendTargets(extendRef, entry.relPath);
    targets.forEach(function (target) {
      if (!visited[target.entry.relPath]) {
        results.push(target.entry);
        Array.prototype.push.apply(results, self._collectExtendedFiles(target.entry.relPath, visited));
      }
    });
  });

  return uniqueEntries(results);
};

WorkspaceIndex.prototype._collectLastExtendedFiles = function _collectLastExtendedFiles(relPath, visited) {
  var entry = this.getEntry(relPath);
  var results = [];
  var self = this;

  if (!entry || !entry.templateInfo || !entry.templateInfo.headerExtendsRefs.length) {
    return results;
  }

  visited = visited || Object.create(null);
  if (visited[entry.relPath]) {
    return results;
  }
  visited[entry.relPath] = true;

  var lastExtendRef = entry.templateInfo.headerExtendsRefs[entry.templateInfo.headerExtendsRefs.length - 1];
  this.resolveExtendTargets(lastExtendRef, entry.relPath).forEach(function (target) {
    if (visited[target.entry.relPath]) {
      return;
    }
    results.push(target.entry);
    Array.prototype.push.apply(results, self._collectLastExtendedFiles(target.entry.relPath, visited));
  });

  return uniqueEntries(results);
};

WorkspaceIndex.prototype.resolveProcessTargets = function resolveProcessTargets(processName, contextRelPath) {
  var results = [];
  var entry = this.getEntry(contextRelPath);

  if (!entry || !entry.templateInfo) {
    return results;
  }

  this._collectLastExtendedFiles(entry.relPath).forEach(function (extendedEntry) {
    (extendedEntry.templateInfo ? extendedEntry.templateInfo.entities : []).forEach(function (entity) {
      if (entity.id === processName) {
        results.push({
          entry: extendedEntry,
          start: entity.start,
          end: entity.end,
          reason: 'last-extended'
        });
      }
    });
  });

  if (results.length) {
    return uniqueFileResults(results);
  }

  this._collectExtendedFiles(entry.relPath).forEach(function (extendedEntry) {
    (extendedEntry.templateInfo ? extendedEntry.templateInfo.entities : []).forEach(function (entity) {
      if (entity.id === processName) {
        results.push({
          entry: extendedEntry,
          start: entity.start,
          end: entity.end,
          reason: 'extended'
        });
      }
    });
  });

  return uniqueFileResults(results);
};

WorkspaceIndex.prototype.resolveL10nTargets = function resolveL10nTargets(l10nId, contextRelPath) {
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, 'auto');
  var results = [];
  var self = this;

  roots.forEach(function (root) {
    if (results.length) {
      return;
    }

    self.l10nFiles.forEach(function (entry) {
      if (!startsWithSegment(entry.relPath, root)) {
        return;
      }
      if (entry.relPath.indexOf('/_dsgn/') === -1 && entry.relPath.indexOf('_dsgn/') !== 0) {
        return;
      }
      (entry.l10nInfo ? entry.l10nInfo.strings : []).forEach(function (item) {
        if (item.id === l10nId) {
          results.push({
            entry: entry,
            start: item.start,
            end: item.end,
            preview: item.preview,
            reason: root === '' ? 'workspace' : 'scoped'
          });
        }
      });
    });
  });

  if (results.length) {
    return uniqueFileResults(results);
  }

  return this._fallbackByPattern(function (entry) {
    if (entry.kind !== 'l10n' || !entry.l10nInfo) {
      return false;
    }
    return entry.l10nInfo.strings.some(function (item) {
      return item.id === l10nId;
    });
  }, roots).map(function (item) {
    var stringItem = item.entry.l10nInfo.strings.filter(function (candidate) {
      return candidate.id === l10nId;
    })[0];
    return {
      entry: item.entry,
      start: stringItem ? stringItem.start : 0,
      end: stringItem ? stringItem.end : 0,
      preview: stringItem ? stringItem.preview : '',
      reason: 'workspace'
    };
  });
};

WorkspaceIndex.prototype.collectScopedL10nIds = function collectScopedL10nIds(contextRelPath) {
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, 'auto');
  var ids = [];
  var self = this;

  roots.forEach(function (root) {
    self.l10nFiles.forEach(function (entry) {
      if (!startsWithSegment(entry.relPath, root) || !entry.l10nInfo) {
        return;
      }
      entry.l10nInfo.strings.forEach(function (stringItem) {
        ids.push(stringItem.id);
      });
    });
  });

  return uniqueStrings(ids).sort();
};

WorkspaceIndex.prototype.collectProcessIds = function collectProcessIds(contextRelPath) {
  var ids = [];
  var entry = this.getEntry(contextRelPath);

  if (!entry || !entry.templateInfo) {
    return ids;
  }

  entry.templateInfo.entities.forEach(function (entity) {
    ids.push(entity.id);
  });

  this._collectExtendedFiles(entry.relPath).forEach(function (extendedEntry) {
    (extendedEntry.templateInfo ? extendedEntry.templateInfo.entities : []).forEach(function (entity) {
      ids.push(entity.id);
    });
  });

  return uniqueStrings(ids).sort();
};

WorkspaceIndex.prototype.resolveIncomingEnvTargets = function resolveIncomingEnvTargets(envKey, contextRelPath) {
  var items = this.incomingEnvByTargetRelPath[normalizeSlashes(contextRelPath)] || [];
  return uniqueFileResults(items.filter(function (item) {
    return item.key === envKey;
  }).map(function (item) {
    return {
      entry: item.entry,
      start: item.start,
      end: item.end,
      preview: item.preview,
      reason: 'incoming-env'
    };
  }));
};

WorkspaceIndex.prototype.collectIncomingEnvKeys = function collectIncomingEnvKeys(contextRelPath) {
  var items = this.incomingEnvByTargetRelPath[normalizeSlashes(contextRelPath)] || [];
  return uniqueStrings(items.map(function (item) {
    return item.key;
  })).sort();
};

WorkspaceIndex.prototype.collectConfKeyNames = function collectConfKeyNames(contextRelPath) {
  var scopeInfo = getScopeInfo(contextRelPath);
  var roots = getRootsForLevel(scopeInfo, 'auto').filter(function (root) {
    return root !== '';
  });
  var keys = [];

  if (!roots.length) {
    roots = [''];
  }

  function pushEntryKeys(entry) {
    if (!entry || !entry.typeInfo) {
      return;
    }
    entry.typeInfo.confKeys.forEach(function (confKey) {
      keys.push(confKey.name);
    });
  }

  pushEntryKeys(this.getEntry(contextRelPath));
  this._collectIncludedTypeEntries(contextRelPath).forEach(pushEntryKeys);

  this.typeFiles.forEach(function (entry) {
    if (!roots.some(function (root) { return startsWithSegment(entry.relPath, root); })) {
      return;
    }
    pushEntryKeys(entry);
  });

  return uniqueStrings(keys).sort();
};

WorkspaceIndex.prototype.collectOutgoingTplVarKeys = function collectOutgoingTplVarKeys(contextRelPath) {
  var entry = this.getEntry(contextRelPath);
  if (!entry || !entry.perlInfo) {
    return [];
  }
  return uniqueStrings(entry.perlInfo.tplVariableWrites.map(function (item) {
    return item.key;
  })).sort();
};

WorkspaceIndex.prototype.resolveTemplateTargetsForTplVariable = function resolveTemplateTargetsForTplVariable(varKey, moduleRelPath) {
  var items = this.templateTargetsByModuleRelPath[normalizeSlashes(moduleRelPath)] || [];
  var entry = this.getEntry(moduleRelPath);
  var hasVar = entry && entry.perlInfo && entry.perlInfo.tplVariableWrites.some(function (item) {
    return item.key === varKey;
  });

  if (!hasVar) {
    return [];
  }

  return uniqueFileResults(items.map(function (item) {
    return {
      entry: item.entry,
      start: 0,
      end: 0,
      preview: item.preview,
      reason: 'tpl-target'
    };
  }));
};

WorkspaceIndex.prototype.collectTemplateVariableKeys = function collectTemplateVariableKeys(contextRelPath) {
  var items = this.templateVarsByTemplateRelPath[normalizeSlashes(contextRelPath)] || [];
  return uniqueStrings(items.map(function (item) {
    return item.key;
  })).sort();
};

WorkspaceIndex.prototype.collectConfigKeys = function collectConfigKeys(contextRelPath) {
  var keys = [];
  var self = this;

  getConfigSearchPaths(contextRelPath).forEach(function (configRelPath) {
    var entry = self.configEntriesByRelPath[configRelPath];
    if (!entry || !entry.configInfo) {
      return;
    }
    entry.configInfo.assignments.forEach(function (item) {
      keys.push(item.key);
    });
  });

  return uniqueStrings(keys).sort();
};

function getConfigSearchPaths(contextRelPath) {
  var scopeInfo = getScopeInfo(contextRelPath);
  var segments = scopeInfo.scopeSegments.slice();
  var branch = '';
  var paths = [];

  if (segments.length && (segments[segments.length - 1] === 'json' || segments[segments.length - 1] === 'xml')) {
    branch = segments.pop();
  }

  if (segments.length && branch) {
    paths.push(segments.join('/') + '/' + branch + '/local.conf');
  }
  if (segments.length) {
    paths.push(segments.join('/') + '/local.conf');
  }
  if (branch) {
    paths.push(branch + '/local.conf');
  }
  paths.push('local.conf');
  paths.push('master.conf');

  return uniqueStrings(paths);
}

WorkspaceIndex.prototype.resolveConfigTargets = function resolveConfigTargets(keyPath, contextRelPath) {
  var results = [];
  var self = this;

  getConfigSearchPaths(contextRelPath).forEach(function (configRelPath) {
    var entry = self.configEntriesByRelPath[configRelPath];
    if (!entry || !entry.configInfo) {
      return;
    }
    (entry.configInfo.assignmentsByKey[keyPath] || []).forEach(function (item) {
      results.push({
        entry: {
          absPath: entry.absPath,
          relPath: entry.relPath
        },
        start: item.start,
        end: item.end,
        preview: item.preview,
        reason: 'config'
      });
    });
  });

  return uniqueFileResults(results);
};

module.exports = {
  WorkspaceIndex: WorkspaceIndex,
  detectFileKind: detectFileKind,
  getConfigSearchPaths: getConfigSearchPaths,
  getScopeInfo: getScopeInfo,
  getRootsForLevel: getRootsForLevel,
  isRelevantFilePath: isRelevantFilePath,
  parseConfigReferences: parseConfigReferences,
  parseL10nReferences: parseL10nReferences,
  parsePerlReferences: parsePerlReferences,
  parseTemplateReferences: parseTemplateReferences,
  parseTypeReferences: parseTypeReferences,
  previewText: previewText,
  uniqueFileResults: uniqueFileResults
};
