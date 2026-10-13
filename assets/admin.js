(function (global) {
  'use strict';
  const DRAFT_KEY = 'qiangtang-academic-site-draft-v1';
  const MAX_IMPORT_BYTES = 3 * 1024 * 1024;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  function normalizeDoi(value) {
    return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim().toLowerCase();
  }
  function isHttpUrl(value) {
    if (!String(value || '').trim()) return true;
    try { return ['http:', 'https:'].includes(new URL(String(value).trim()).protocol); }
    catch (_) { return false; }
  }
  function validateSite(value, complete = false) {
    const errors = [];
    if (!isObject(value)) return ['JSON 顶层必须是对象。'];
    if (!isObject(value.profile)) errors.push('需要 profile 个人介绍对象。');
    if (!Array.isArray(value.projects)) errors.push('projects 必须是项目数组。');
    if (!Array.isArray(value.publications)) errors.push('publications 必须是人工论文数组。');
    if (errors.length) return errors;
    if (complete && !String(value.profile.name_cn || value.profile.name_en || '').trim()) errors.push('请填写中文或英文姓名。');
    const seen = new Set();
    value.publications.forEach((paper, index) => {
      if (!isObject(paper)) { errors.push(`第 ${index + 1} 篇论文必须是对象。`); return; }
      if (complete && !String(paper.Title || '').trim()) errors.push(`第 ${index + 1} 篇论文缺少标题。`);
      if (complete && !isHttpUrl(paper.URL)) errors.push(`第 ${index + 1} 篇论文的链接必须是完整的 HTTP(S) 网址。`);
      if (paper.Year !== '' && paper.Year != null && (!Number.isInteger(Number(paper.Year)) || Number(paper.Year) < 1900 || Number(paper.Year) > 2100)) errors.push(`第 ${index + 1} 篇论文的年份应在 1900–2100 之间。`);
      const doi = normalizeDoi(paper.DOI);
      if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi)) errors.push(`第 ${index + 1} 篇论文的 DOI 格式不正确。`);
      if (doi && seen.has(doi)) errors.push(`DOI 重复：${doi}，请保留一条人工记录。`);
      if (doi) seen.add(doi);
    });
    value.projects.forEach((project, index) => {
      if (!isObject(project)) { errors.push(`第 ${index + 1} 个项目必须是对象。`); return; }
      if (complete && !String(project.ProjectName || project.DisplayText || '').trim()) errors.push(`第 ${index + 1} 个项目缺少名称。`);
      if (complete && !isHttpUrl(project.SourceURL)) errors.push(`第 ${index + 1} 个项目的链接必须是完整的 HTTP(S) 网址。`);
      if (project.AmountWan !== '' && project.AmountWan != null && (!Number.isFinite(Number(project.AmountWan)) || Number(project.AmountWan) < 0)) errors.push(`第 ${index + 1} 个项目的经费应为非负数字。`);
    });
    return errors;
  }
  function parseSiteJson(text) {
    if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new Error('JSON 文件过大，请控制在 3 MB 以内。');
    const value = JSON.parse(text);
    const errors = validateSite(value);
    if (errors.length) throw new Error(errors.join('\n'));
    return value;
  }
  function prepareExport(data, complete = true) {
    const errors = validateSite(data, complete);
    if (errors.length) throw new Error(errors.join('\n'));
    const output = clone(data);
    output.publications.forEach((paper) => { if (paper.DOI) paper.DOI = normalizeDoi(paper.DOI); });
    output.updated_at = new Date().toISOString();
    return JSON.stringify(output, null, 2) + '\n';
  }
  function projectDisplay(project) {
    const dates = [project.Start, project.End].filter(Boolean).join(' - ');
    const details = [project.FundingType, project.Number ? `No. ${project.Number}` : '', dates].filter(Boolean).join('，');
    const amount = project.AmountWan === '' || project.AmountWan == null ? '' : `${project.AmountWan}万元`;
    return `${project.ProjectName || ''}${details ? '；' + details : ''}${details ? '。' : ''}${amount}`;
  }
  const api = { normalizeDoi, isHttpUrl, validateSite, parseSiteJson, prepareExport, projectDisplay };
  global.AcademicAdminData = Object.freeze(api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  let data = null;
  let publishedData = null;
  let draftCandidate = null;
  let draftTimer = null;
  let changed = false;
  let loading = false;
  let activeTab = 'profile';
  let draftBaseUpdatedAt = '';
  const byId = (id) => document.getElementById(id);
  function status(message, kind = 'info') {
    byId('admin-status').textContent = message;
    byId('admin-status').dataset.kind = kind;
  }
  function setBusy(value) {
    loading = value;
    ['copy-json', 'download-json', 'add-project', 'add-publication', 'apply-json'].forEach((id) => { byId(id).disabled = value || !data; });
  }
  function editUrl() {
    const cfg = data?.github || {};
    const owner = cfg.owner || 'tomtaylor1992911-lang';
    const repo = cfg.repo || 'tomtaylor1992911-lang.github.io';
    const branch = cfg.branch || 'main';
    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/edit/${encodeURIComponent(branch)}/data/site.json`;
  }
  function saveDraft() {
    if (!data || !changed) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, saved_at: new Date().toISOString(), base_updated_at: draftBaseUpdatedAt, data }));
      status(`本机草稿已保存 · ${new Date().toLocaleTimeString('zh-CN')}。尚未发布；请复制 JSON 并提交到 GitHub。`);
    } catch (_) {
      status('浏览器无法保存草稿。请下载 site.json 保留修改，再提交到 GitHub。', 'warning');
    }
  }
  function markChanged() {
    changed = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 350);
    status('内容已修改，正在保存本机草稿；尚未发布。');
  }
  function readDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!saved || saved.version !== 1 || validateSite(saved.data).length) return null;
      return saved;
    } catch (_) { return null; }
  }
  function showDraftBanner(saved) {
    draftCandidate = saved;
    byId('draft-banner').hidden = !saved;
    if (!saved) return;
    const date = new Date(saved.saved_at).toLocaleString('zh-CN');
    const stale = (saved.base_updated_at || '') !== (publishedData?.updated_at || '');
    byId('draft-message').textContent = `发现 ${date} 保存的本机草稿。${stale ? '已发布数据在草稿创建后发生变化，恢复前请先备份并核对完整 JSON，避免覆盖后续更新。' : '可恢复并继续修改；恢复不会发布。'}`;
  }
  function field(target, scope, index, key, label, type = 'text', options = {}) {
    const wrapper = document.createElement('label');
    wrapper.className = 'admin-field' + (options.wide ? ' wide' : '');
    const caption = document.createElement('span');
    caption.textContent = label;
    wrapper.append(caption);
    let input;
    if (type === 'textarea') input = document.createElement('textarea');
    else if (type === 'select') {
      input = document.createElement('select');
      (options.values || []).forEach((value) => {
        const option = document.createElement('option'); option.value = value; option.textContent = value || '未填写'; input.append(option);
      });
      if (target[key] != null && !(options.values || []).includes(String(target[key]))) {
        const extra = document.createElement('option'); extra.value = String(target[key]); extra.textContent = String(target[key]); input.append(extra);
      }
    } else { input = document.createElement('input'); input.type = type; }
    input.value = target[key] == null ? '' : target[key];
    input.dataset.scope = scope;
    input.dataset.index = index;
    input.dataset.key = key;
    if (type === 'number') { input.step = options.step || 'any'; if (options.min != null) input.min = options.min; if (options.max != null) input.max = options.max; }
    if (options.placeholder) input.placeholder = options.placeholder;
    wrapper.append(input);
    if (options.help) { const help = document.createElement('span'); help.className = 'field-help'; help.textContent = options.help; wrapper.append(help); }
    return wrapper;
  }
  function renderProfile() {
    const form = byId('profile-form'); form.replaceChildren();
    const fields = [
      ['name_cn', '中文姓名'], ['name_en', '英文姓名'], ['title_line', '职称与身份'],
      ['research_direction', '研究方向'], ['email', '公开联系邮箱', 'email'],
      ['orcid', 'ORCID iD', 'text', { help: '更换同步账号还需修改同步工作流的 ORCID 配置。' }],
      ['profile', '个人介绍', 'textarea', { wide: true }]
    ];
    fields.forEach(([key, label, type, options]) => form.append(field(data.profile, 'profile', 0, key, label, type || 'text', options || {})));
  }
  function itemCard(scope, item, index, title) {
    const card = document.createElement('details'); card.className = 'admin-card'; card.dataset.scope = scope; card.dataset.index = index;
    const summary = document.createElement('summary');
    const text = document.createElement('span'); text.className = 'card-title'; text.textContent = title || '待填写';
    const hint = document.createElement('span'); hint.textContent = '点击编辑'; summary.append(text, hint); card.append(summary);
    const grid = document.createElement('div'); grid.className = 'admin-grid'; card.append(grid);
    const actions = document.createElement('div'); actions.className = 'admin-card-actions';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.dataset.remove = scope; remove.dataset.index = index; remove.textContent = scope === 'projects' ? '删除此项目' : '删除此论文'; actions.append(remove); card.append(actions);
    return { card, grid };
  }
  function renderProjects() {
    const list = byId('project-list'); list.replaceChildren();
    data.projects.forEach((project, index) => {
      const { card, grid } = itemCard('projects', project, index, project.ProjectName || project.DisplayText);
      const fields = [
        ['ProjectName', '项目名称', 'text', { wide: true }],
        ['Category', '项目类别', 'select', { values: ['', '科研项目', '开放代码'] }],
        ['SourceURL', '项目或代码链接', 'url', { placeholder: 'https://github.com/…', help: '可选；填写完整的 HTTP(S) 链接。' }],
        ['Description', '项目简介', 'textarea', { wide: true }], ['FundingType', '资助类别'], ['Number', '项目编号'],
        ['Start', '开始时间', 'text', { placeholder: '2026.01' }], ['End', '结束时间', 'text', { placeholder: '2028.12 或 至今' }],
        ['AmountWan', '经费（万元）', 'number', { min: 0 }], ['Order', '展示顺序', 'number', { min: 0, step: 1 }],
        ['DisplayText', '展示文字', 'textarea', { wide: true, help: '主页按这段文字展示；可包含项目状态、承担角色等信息。' }]
      ];
      fields.forEach(([key, label, type, options]) => grid.append(field(project, 'projects', index, key, label, type || 'text', options || {})));
      const generate = document.createElement('button'); generate.type = 'button'; generate.textContent = '用项目字段生成展示文字'; generate.dataset.generate = index; grid.append(generate);
      list.append(card);
    });
    byId('project-count').textContent = `(${data.projects.length})`;
  }
  function renderPublications() {
    const list = byId('publication-list'); list.replaceChildren();
    data.publications.forEach((paper, index) => {
      const { card, grid } = itemCard('publications', paper, index, paper.Title);
      const fields = [
        ['Title', '论文标题', 'text', { wide: true }], ['Authors', '作者', 'text', { wide: true }], ['Journal', '期刊 / 会议'],
        ['Year', '年份', 'number', { min: 1900, max: 2100, step: 1 }], ['DOI', 'DOI', 'text', { help: '可粘贴 DOI 或 https://doi.org/… 链接。' }],
        ['URL', '论文链接（可选）', 'url', { help: '无 DOI 时可填写论文、预印本或成果页面的完整 HTTP(S) 网址。' }],
        ['AuthorRole', '本人作者身份'], ['PublicationDetail', '卷、期、页码 / 文章号'],
        ['Status', '发表状态', 'select', { values: ['Published', 'Accepted', 'In press', 'Preprint', 'Submitted', ''] }],
        ['Representative', '设为代表作', 'select', { values: ['否', '是'] }], ['RepresentativeOrder', '代表作展示顺序', 'number', { min: 0, step: 1 }],
        ['DisplayOrder', '论文展示顺序', 'number', { min: 0, step: 1 }], ['CAS_Zone', '中科院分区', 'select', { values: ['', '1区', '2区', '3区', '4区', '未收录'] }],
        ['CAS_TOP', 'TOP 期刊', 'select', { values: ['', '否', '是'] }], ['JIF', '影响因子（可选）', 'number', { min: 0 }],
        ['JIF_Year', '影响因子统计年份', 'number', { min: 1900, max: 2100, step: 1 }]
      ];
      fields.forEach(([key, label, type, options]) => grid.append(field(paper, 'publications', index, key, label, type || 'text', options || {})));
      list.append(card);
    });
    byId('publication-count').textContent = `(${data.publications.length})`;
    filterPublications();
  }
  function filterPublications() {
    const query = byId('publication-search').value.trim().toLowerCase();
    byId('publication-list').querySelectorAll('details').forEach((card) => {
      const paper = data.publications[Number(card.dataset.index)];
      card.hidden = Boolean(query && ![paper.Title, paper.Authors, paper.Journal, paper.Year, paper.DOI].join(' ').toLowerCase().includes(query));
    });
  }
  function refreshLinks() {
    byId('github-edit').href = editUrl();
    const cfg = data.github || {};
    byId('actions-link').href = `https://github.com/${encodeURIComponent(cfg.owner || 'tomtaylor1992911-lang')}/${encodeURIComponent(cfg.repo || 'tomtaylor1992911-lang.github.io')}/actions`;
    const orcid = String(data.sync?.orcid || data.profile.orcid || '0000-0003-0360-5526').trim();
    byId('orcid-link').href = `https://orcid.org/${encodeURIComponent(orcid)}`;
    byId('sync-description').textContent = `${data.sync?.schedule || '每日北京时间上午 10:23'}，从 ORCID ${orcid} 读取公开成果。`;
  }
  function renderAll() {
    renderProfile(); renderProjects(); renderPublications(); refreshLinks();
    byId('json-editor').value = JSON.stringify(data, null, 2);
    setBusy(false);
  }
  function selectTab(tab) {
    if (activeTab === 'json' && tab !== 'json' && data && byId('json-editor').value !== JSON.stringify(data, null, 2)) {
      if (!global.confirm('完整 JSON 中有尚未应用的修改。离开将放弃这些文字修改；建议先应用到草稿。仍要离开吗？')) return;
    }
    activeTab = tab;
    document.querySelectorAll('[data-tab]').forEach((button) => { button.setAttribute('aria-selected', String(button.dataset.tab === tab)); });
    ['profile', 'projects', 'publications', 'sync', 'json'].forEach((name) => { byId(`panel-${name}`).hidden = name !== tab; });
    if (tab === 'json' && data) byId('json-editor').value = JSON.stringify(data, null, 2);
  }
  async function fetchPublished() {
    const response = await fetch('data/site.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）。`);
    return parseSiteJson(await response.text());
  }
  async function loadPublished(ask = false) {
    if (loading) return;
    if (ask && changed && !global.confirm('重新读取将放弃当前编辑内容。请先下载草稿备份。继续吗？')) return;
    clearTimeout(draftTimer);
    setBusy(true);
    try {
      publishedData = await fetchPublished(); data = clone(publishedData); changed = false; draftBaseUpdatedAt = publishedData.updated_at || '';
      renderAll(); showDraftBanner(readDraft());
      status(`已读取发布版本${data.updated_at ? ' · ' + new Date(data.updated_at).toLocaleString('zh-CN') : ''}。修改后请提交 GitHub 才会发布。`);
    } catch (error) { status(`${error.message} 可导入已下载的 site.json 继续编辑。`, 'error'); setBusy(false); }
  }
  async function exportText(complete = true) {
    if (!data) throw new Error('请先读取或导入数据。');
    if (activeTab === 'json' && byId('json-editor').value !== JSON.stringify(data, null, 2)) throw new Error('完整 JSON 中有未应用的修改，请先点击“应用 JSON 到草稿”。');
    const text = prepareExport(data, complete);
    if (publishedData) {
      try {
        const latest = await fetchPublished();
        if (JSON.stringify(latest) !== JSON.stringify(publishedData) || draftBaseUpdatedAt !== (latest.updated_at || '')) {
          status('发布版本已更新。请先下载当前草稿，重新读取已发布内容并合并修改，避免覆盖他人的更新。', 'warning');
          if (!global.confirm('发布数据已更新。当前导出是旧版本草稿；建议仅用于备份，再与最新版本合并。仍要导出吗？')) return null;
        }
      } catch (error) {
        status('暂时无法核对最新发布版本。导出后请在 GitHub 提交前检查文件是否有更新。', 'warning');
      }
    }
    return text;
  }
  async function copyJson() {
    try {
      const text = await exportText(); if (!text) return;
      try { await navigator.clipboard.writeText(text); }
      catch (_) {
        selectTab('json'); byId('json-editor').value = text; byId('json-editor').focus(); byId('json-editor').select();
        status('浏览器未允许自动复制。JSON 已选中，请按 Ctrl+C，再打开 GitHub 编辑页提交。', 'warning'); return;
      }
      status('JSON 已复制。现在打开 GitHub 编辑页，全选替换 data/site.json 并提交；主页将在部署后更新。', 'success');
    } catch (error) { status(error.message, 'error'); }
  }
  async function downloadJson() {
    try {
      const text = await exportText(false); if (!text) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'site.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('site.json 草稿备份已下载。发布前请通过“复制发布 JSON”检查必填项，再提交 GitHub。', 'success');
    } catch (error) { status(error.message, 'error'); }
  }
  function importText(text) {
    const next = parseSiteJson(text);
    if (data && !global.confirm('导入会替换当前编辑内容。已有草稿请先下载备份。继续吗？')) return;
    data = next; draftBaseUpdatedAt = next.updated_at || publishedData?.updated_at || ''; renderAll(); markChanged();
  }
  document.addEventListener('input', (event) => {
    const input = event.target;
    if (input.id === 'publication-search') { if (data) filterPublications(); return; }
    if (!input.dataset.scope || !data) return;
    const scope = input.dataset.scope;
    const target = scope === 'profile' ? data.profile : data[scope][Number(input.dataset.index)];
    if (!target) return;
    target[input.dataset.key] = input.type === 'number' && input.value !== '' ? Number(input.value) : input.value;
    const card = input.closest('details');
    if (card) card.querySelector('.card-title').textContent = target.Title || target.ProjectName || target.DisplayText || '待填写';
    markChanged();
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.tab) { selectTab(button.dataset.tab); return; }
    if (button.dataset.remove && data) {
      const scope = button.dataset.remove; const index = Number(button.dataset.index);
      const name = data[scope][index].Title || data[scope][index].ProjectName || '这条记录';
      if (!global.confirm(`从本机草稿删除“${name}”？提交到 GitHub 后才会从主页删除。`)) return;
      data[scope].splice(index, 1); scope === 'projects' ? renderProjects() : renderPublications(); markChanged();
    }
    if (button.dataset.generate != null && data) {
      const index = Number(button.dataset.generate); data.projects[index].DisplayText = projectDisplay(data.projects[index]);
      button.closest('details').querySelector('[data-key="DisplayText"]').value = data.projects[index].DisplayText; markChanged();
    }
  });
  byId('copy-json').addEventListener('click', copyJson);
  byId('download-json').addEventListener('click', downloadJson);
  byId('reload-published').addEventListener('click', () => loadPublished(true));
  byId('import-file').addEventListener('click', () => byId('json-file').click());
  byId('json-file').addEventListener('change', async (event) => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > MAX_IMPORT_BYTES) throw new Error('文件过大，请控制在 3 MB 以内。'); importText(await file.text()); }
    catch (error) { status(error.message, 'error'); }
    event.target.value = '';
  });
  byId('apply-json').addEventListener('click', () => { try { importText(byId('json-editor').value); } catch (error) { status(error.message, 'error'); } });
  byId('restore-draft').addEventListener('click', () => {
    if (!draftCandidate) return;
    const stale = (draftCandidate.base_updated_at || '') !== (publishedData?.updated_at || '');
    if (stale && !global.confirm('草稿基于较旧的发布版本。恢复后请对照最新版本合并，避免覆盖更新。仍然恢复吗？')) return;
    data = clone(draftCandidate.data); draftBaseUpdatedAt = draftCandidate.base_updated_at || ''; renderAll(); changed = true; showDraftBanner(null); status('已恢复本机草稿。请检查后复制 JSON 并提交 GitHub。', 'warning');
  });
  byId('discard-draft').addEventListener('click', () => {
    if (!global.confirm('删除此浏览器中的草稿？已发布内容不受影响。')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* Browser storage may be unavailable. */ }
    showDraftBanner(null); status('本机草稿已删除。');
  });
  byId('add-project').addEventListener('click', () => {
    if (!data) return;
    data.projects.push({ ProjectName: '', Category: '科研项目', SourceURL: '', Description: '', FundingType: '', Number: '', Start: '', End: '', AmountWan: '', DisplayText: '', Order: data.projects.length + 1 });
    renderProjects(); byId('project-list').lastElementChild.open = true; byId('project-list').lastElementChild.querySelector('input').focus(); markChanged();
  });
  byId('add-publication').addEventListener('click', () => {
    if (!data) return;
    const id = Math.max(0, ...data.publications.map((paper) => Number(paper.ID) || 0)) + 1;
    data.publications.unshift({ ID: id, Title: '', Authors: '', Journal: '', Year: new Date().getFullYear(), DOI: '', URL: '', AuthorRole: '', PublicationDetail: '', Status: 'Published', Representative: '否', RepresentativeOrder: '', DisplayOrder: 0, CAS_Zone: '', CAS_TOP: '', JIF: '', JIF_Year: '' });
    byId('publication-search').value = ''; renderPublications(); byId('publication-list').firstElementChild.open = true; byId('publication-list').firstElementChild.querySelector('input').focus(); markChanged();
  });
  global.addEventListener('pagehide', () => { clearTimeout(draftTimer); saveDraft(); });
  loadPublished();
})(globalThis);
