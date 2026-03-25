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

function firstModuleBlock(relativePath, blockIndex) {
  var parsed = resolver.parseTypeReferences(read(relativePath));
  return parsed.blocks[blockIndex || 0];
}

index.rebuild();

assert(index.fileEntries.length > 100, 'Workspace index looks too small.');

var liveBlock = firstModuleBlock('_type/l_tv_live.pub.type', 0);
var liveTargets = index.resolveModuleBlockTargets(liveBlock, '_type/l_tv_live.pub.type');

assert(
  liveTargets.moduleEntries.length && liveTargets.moduleEntries[0].entry.relPath === '_mdl/510-broadcast.now.mdl',
  'Failed to resolve _type/l_tv_live.pub.type -> _mdl/510-broadcast.now.mdl'
);
assert(
  liveTargets.templateEntries.length && liveTargets.templateEntries[0].entry.relPath === '_mdl/510-broadcast.now.live_v3.tpl',
  'Failed to resolve _type/l_tv_live.pub.type -> _mdl/510-broadcast.now.live_v3.tpl'
);

var processTargets = index.resolveProcessTargets('seo_header', '_mdl/21-container.0.search.tpl');
assert(
  processTargets.some(function (item) { return item.entry.relPath === '_dsgn/seo_toolkit.xhtml.tpl'; }),
  'Failed to resolve PROCESS seo_header from _mdl/21-container.0.search.tpl'
);

var livePlayerTargets = index.resolveProcessTargets('player_embed_live', '_mdl/510-broadcast.now.live_v3.tpl');
assert(
  livePlayerTargets.some(function (item) { return item.entry.relPath === '_dsgn/player.xhtml.tpl'; }),
  'Failed to resolve PROCESS player_embed_live through the connected header graph'
);

var liveSchemaTargets = index.resolveProcessTargets('schema_video_live', '_mdl/510-broadcast.now.live_v3.tpl');
assert(
  liveSchemaTargets.some(function (item) { return item.entry.relPath === '_dsgn/seo_schema.xhtml.tpl'; }),
  'Failed to resolve PROCESS schema_video_live through the connected header graph'
);

var l10nTargets = index.resolveL10nTargets('cookie.box.title', '_dsgn/cookies.xhtml.tpl');
assert(
  l10nTargets.some(function (item) { return item.entry.relPath === '_dsgn/cookies.L10n'; }),
  'Failed to resolve L10n cookie.box.title from _dsgn/cookies.xhtml.tpl'
);

var includeTargets = index.resolveIncludeTargets('layer_final', '!dokoran/_type/l_default.pub.type');
assert(
  includeTargets.some(function (item) { return item.entry.relPath === '!dokoran/_type/layer_final.inc'; }),
  'Failed to resolve include layer_final from !dokoran/_type/l_default.pub.type'
);

var articleTypeBlock = firstModuleBlock('_type/l_article_view.pub.type', 3);
var articleSmdlTargets = index.resolveTypeAttributeTargets(articleTypeBlock, '-name', '_type/l_article_view.pub.type');
assert(
  articleSmdlTargets.some(function (item) { return item.entry.relPath === '_mdl/401-article_view.2013.smdl'; }),
  'Failed to resolve smdl module from _type/l_article_view.pub.type'
);

var tmpTargets = index.resolveTmpTargets('ARTICLE-SECTION', '_type/l_radio_homepage.pub.type');
assert(
  tmpTargets.some(function (item) { return item.entry.relPath === '_mdl/010-radio_home.tpl.default.tpl'; }),
  'Failed to resolve TMP ARTICLE-SECTION placeholder'
);

var tvSeriesType = resolver.parseTypeReferences(read('_type/l_tv_series_list.pub.type'));
var tvSeriesChildTmpTargets = index.resolveTypeAttributeTargets(tvSeriesType.blocks[1], '-TMP', '_type/l_tv_series_list.pub.type', tvSeriesType.blocks);
assert(
  tvSeriesChildTmpTargets.some(function (item) { return item.entry.relPath === '_mdl/21-container.0.tv_series_list.tpl'; }),
  'Failed to resolve nested TMP SERIES-LIST to the parent tpl in _type/l_tv_series_list.pub.type'
);

var tvSeriesParentTmpTargets = index.resolveTypeAttributeTargets(tvSeriesType.blocks[0], '-TMP', '_type/l_tv_series_list.pub.type', tvSeriesType.blocks);
assert(
  tvSeriesParentTmpTargets.some(function (item) { return item.entry.relPath === '_dsgn/new.body'; }),
  'Failed to resolve top-level TMP CONTAINER to the body layout'
);

var searchSmdl = resolver.parsePerlReferences(read('_mdl/010-search.0.smdl'));
var searchTmpTargets = index.resolveTypeAttributeTargets(searchSmdl.callBlocks[2], '-TMP', '_mdl/010-search.0.smdl', searchSmdl.callBlocks);
assert(
  searchTmpTargets.some(function (item) { return item.entry.relPath === '_mdl/510-broadcast.0.search.tpl'; }),
  'Failed to resolve TMP SEARCH-TV inside _mdl/010-search.0.smdl'
);

var configTargets = index.resolveConfigTargets('flowplayer_key', '_mdl/21-container.0.search.tpl');
assert(
  configTargets.some(function (item) { return item.entry.relPath === 'master.conf'; }),
  'Failed to resolve domain.setup.flowplayer_key to master.conf'
);

var archivSeriesEnvTargets = index.resolveIncomingEnvTargets('series', '_mdl/510-broadcast_program_view.archiv.mdl');
assert(
  archivSeriesEnvTargets.some(function (item) {
    return item.entry.relPath === '_type/l_tv_archiv_view.pub.type' &&
      item.preview === 'get series';
  }),
  'Failed to resolve $env{series} back to get="series" in _type/l_tv_archiv_view.pub.type'
);

var recipeConfKeyTargets = index.resolveConfKeyTargets('article.ID_entity', '_type/l_theme_pcs_view_recipe.pub.type');
assert(
  recipeConfKeyTargets.some(function (item) {
    return item.entry.relPath === '_type/l_theme_pcs_view_recipe.pub.type' &&
      item.preview === 'CONF_KEY article.ID_entity';
  }),
  'Failed to resolve key="article.ID_entity" to the matching CONF_KEY'
);

var recipeIncomingEnvTargets = index.resolveIncomingEnvTargets('article.ID_entity', '_mdl/401-article_autoredirect.recipe.mdl');
assert(
  recipeIncomingEnvTargets.some(function (item) {
    return item.entry.relPath === '_type/l_theme_pcs_view_recipe.pub.type' &&
      item.preview === 'CONF_KEY article.ID_entity';
  }),
  'Failed to resolve incoming article.ID_entity env back to CONF_KEY article.ID_entity'
);

var recipeNameUrlTargets = index.resolveIncomingEnvTargets('article_attrs.name_url', '_mdl/401-article_autoredirect.recipe.mdl');
assert(
  recipeNameUrlTargets.some(function (item) {
    return item.entry.relPath === '_type/l_theme_pcs_view_recipe.pub.type' &&
      item.preview === 'get name_url';
  }),
  'Failed to resolve incoming article_attrs.name_url env back to get="name_url"'
);

assert(
  index.collectConfKeyNames('_type/l_theme_pcs_view_recipe.pub.type').indexOf('article.ID_entity') !== -1,
  'Failed to expose CONF_KEY names for key="" completion in _type/l_theme_pcs_view_recipe.pub.type'
);

assert(
  index.collectIncomingEnvKeys('_mdl/510-broadcast_series.list.default_new.tpl').indexOf('page_limit') !== -1,
  'Failed to expose incoming env keys for template targets'
);

assert(
  index.collectOutgoingTplVarKeys('_mdl/510-broadcast_program_view.archiv.mdl').indexOf('only_one') !== -1,
  'Failed to collect $TPL->{variables} keys from mdl files'
);

process.stdout.write('Cyclone CML smoke test passed.\n');
