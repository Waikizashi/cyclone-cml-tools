'use strict';

var fs = require('fs');
var path = require('path');
var resolver = require('../resolver');

var workspaceRoot = path.resolve(__dirname, '..', '..', '..');
var index = new resolver.WorkspaceIndex(workspaceRoot);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function typeBlock(relativePath, blockIndex) {
  return resolver.parseTypeReferences(read(relativePath)).blocks[blockIndex || 0];
}

function someResult(results, predicate) {
  return (results || []).some(predicate);
}

index.rebuild();

assert(index.fileEntries.length > 100, 'Workspace index looks too small.');

var grantFrameBlock = typeBlock('bojovnici/_type/l_grant1.pub.type', 0);
var grantFormBlock = typeBlock('bojovnici/_type/l_grant1.pub.type', 1);
var grantFrameTargets = index.resolveModuleBlockTargets(grantFrameBlock, 'bojovnici/_type/l_grant1.pub.type');
var grantFormTargets = index.resolveModuleBlockTargets(grantFormBlock, 'bojovnici/_type/l_grant1.pub.type');

assert(
  someResult(grantFrameTargets.templateEntries, function (item) {
    return item.entry.relPath === 'bojovnici/_mdl/23-site_frame.tpl.grant1.tpl';
  }),
  'Failed to resolve bojovnici grant frame tpl.'
);

assert(
  someResult(grantFormTargets.moduleEntries, function (item) {
    return item.entry.relPath === 'bojovnici/_mdl/130-form_registracia_bojovnika.0.mdl';
  }),
  'Failed to resolve bojovnici registration mdl.'
);

assert(
  someResult(grantFormTargets.templateEntries, function (item) {
    return item.entry.relPath === 'bojovnici/_mdl/130-form_registracia_bojovnika.0.default.tpl';
  }),
  'Failed to resolve bojovnici registration tpl.'
);

var grantTmpTargets = index.resolveTypeAttributeTargets(
  grantFormBlock,
  '-TMP',
  'bojovnici/_type/l_grant1.pub.type',
  resolver.parseTypeReferences(read('bojovnici/_type/l_grant1.pub.type')).blocks
);
assert(
  someResult(grantTmpTargets, function (item) {
    return item.entry.relPath === 'bojovnici/_mdl/23-site_frame.tpl.grant1.tpl';
  }),
  'Failed to resolve TMP KONTROLA to the parent grant frame tpl.'
);

var processTargets = index.resolveProcessTargets('seo_header', 'bojovnici/_mdl/401-article_view.2013.pribeh_detail.tpl');
assert(
  someResult(processTargets, function (item) {
    return item.entry.relPath === '_dsgn/common.xhtml.tpl';
  }),
  'Failed to resolve PROCESS seo_header to common.xhtml.tpl.'
);

var l10nTargets = index.resolveL10nTargets('countdown.active', 'bojovnici/_mdl/21-countdown.0.default.tpl');
assert(
  someResult(l10nTargets, function (item) {
    return item.entry.relPath === 'bojovnici/_dsgn/countdown.L10n';
  }),
  'Failed to resolve bojovnici countdown L10n.'
);

var l10nFileTargets = index.resolveL10nFileTargets('obezita', 'obezita/_mdl/23-notfound.0.default.tpl', 'auto');
assert(
  someResult(l10nFileTargets, function (item) {
    return item.entry.relPath === 'obezita/_dsgn/obezita.L10n';
  }),
  'Failed to resolve obezita L10n include file.'
);

var countdownConfigTargets = index.resolveConfigTargets('countdown_start.year', 'bojovnici/_mdl/21-countdown.0.default.tpl');
assert(
  someResult(countdownConfigTargets, function (item) {
    return item.entry.relPath === 'bojovnici/local.conf';
  }),
  'Failed to resolve countdown_start.year to bojovnici/local.conf.'
);

assert(
  index.collectConfigKeys('bojovnici/_mdl/21-countdown.0.default.tpl').indexOf('countdown_stop.minute') !== -1,
  'Failed to expose nested countdown_stop.minute config key.'
);

var genericConfigTargets = index.resolveConfigVarTargets('tom::bojovnici_form_ID_entity', 'bojovnici/_mdl/130-form_registracia_bojovnika.0.mdl');
assert(
  someResult(genericConfigTargets, function (item) {
    return item.entry.relPath === 'bojovnici/local.conf';
  }),
  'Failed to resolve generic config variable tom::bojovnici_form_ID_entity.'
);

assert(
  index.collectConfigVarKeys('bojovnici/_mdl/130-form_registracia_bojovnika.0.mdl').indexOf('TOM::DB.main.name') !== -1,
  'Failed to expose generic config key TOM::DB.main.name.'
);

var bojovniciIncomingStep = index.resolveIncomingEnvTargets('step', 'bojovnici/_mdl/130-form_registracia_bojovnika.0.default.tpl');
assert(
  someResult(bojovniciIncomingStep, function (item) {
    return item.entry.relPath === 'bojovnici/_type/l_grant1.pub.type' && item.preview === 'get step';
  }),
  'Failed to resolve incoming step env for bojovnici registration tpl.'
);

assert(
  index.collectTemplateVariableKeys('bojovnici/_mdl/130-form_registracia_bojovnika.0.default.tpl').indexOf('step') !== -1,
  'Failed to expose tpl variable step for bojovnici registration tpl.'
);

var bojovniciTplVarTargets = index.resolveTemplateVariableSources('step', 'bojovnici/_mdl/130-form_registracia_bojovnika.0.default.tpl');
assert(
  someResult(bojovniciTplVarTargets, function (item) {
    return item.entry.relPath === 'bojovnici/_mdl/130-form_registracia_bojovnika.0.mdl';
  }),
  'Failed to resolve tpl variable step back to bojovnici registration mdl.'
);

var nepokryteIncomingStep = index.resolveIncomingEnvTargets('step', '_mdl/010-NepokryteObdobia.form.default.tpl');
assert(
  someResult(nepokryteIncomingStep, function (item) {
    return /l_nepokryte_obdobia\.pub\.type$/.test(item.entry.relPath) && item.preview === 'get step';
  }),
  'Failed to resolve incoming step env for NepokryteObdobia tpl.'
);

var nepokryteTplVarTargets = index.resolveTemplateVariableSources('step', '_mdl/010-NepokryteObdobia.form.default.tpl');
assert(
  someResult(nepokryteTplVarTargets, function (item) {
    return item.entry.relPath === '_mdl/010-NepokryteObdobia.form.mdl';
  }),
  'Failed to resolve tpl variable step back to NepokryteObdobia mdl.'
);

assert(
  index.collectConfKeyNames('_type/l_homepage.pub.type').indexOf('article_cat_ID') !== -1,
  'Failed to expose CONF_KEY article_cat_ID for completion.'
);

var confKeyTargets = index.resolveConfKeyTargets('article_cat_ID', '_type/l_homepage.pub.type');
assert(
  someResult(confKeyTargets, function (item) {
    return item.preview === 'CONF_KEY article_cat_ID';
  }),
  'Failed to resolve CONF_KEY article_cat_ID.'
);

process.stdout.write('Cyclone CML smoke test passed.\n');
