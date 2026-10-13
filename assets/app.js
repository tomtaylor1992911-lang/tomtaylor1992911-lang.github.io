(function () {
  'use strict';

  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
  const pick = (...values) => values.map(text).find(Boolean) || '';
  const authorText = value => Array.isArray(value) ? value.map(item => typeof item === 'object' ? pick(item.name, item.credit_name) : text(item)).filter(Boolean).join(', ') : text(value);
  const normalizeDOI = value => text(value).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, '').replace(/\s+/g, '').toLowerCase();
  const normalizedTitle = value => text(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}]/gu, '');
  const validDOI = value => /^10\.\d{4,9}\/\S+$/i.test(normalizeDOI(value));
  const safeURL = value => {
    const raw = text(value);
    if (!raw || /[\u0000-\u001F\u007F]/.test(raw)) return '';
    try {
      const parsed = new URL(raw);
      return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : '';
    } catch (_) { return ''; }
  };
  const doiURL = value => validDOI(value) ? 'https://doi.org/' + normalizeDOI(value).split('/').map(encodeURIComponent).join('/') : '';
  const truthy = value => value === true || value === 1 || ['是', 'true', 'yes', '1'].includes(text(value).toLowerCase());
  const order = (value, fallback = Number.MAX_SAFE_INTEGER) => text(value) && Number.isFinite(Number(value)) ? Number(value) : fallback;
  const paperTypeLabel = type => ({'journal-article': '期刊论文', 'conference-paper': '会议论文', 'conference-abstract': '会议摘要', 'preprint': '预印本', 'book-chapter': '书籍章节', 'book': '专著', 'dissertation-thesis': '学位论文', 'report': '报告', 'other': '其他成果'})[type] || '其他成果';
  const normalizePaper = (paper, source) => ({
    ...paper,
    Title: pick(paper.Title, paper.title),
    Authors: pick(authorText(paper.Authors), authorText(paper.authors)),
    Journal: pick(paper.Journal, paper.journal),
    Year: pick(paper.Year, paper.year),
    DOI: normalizeDOI(pick(paper.DOI, paper.doi)),
    URL: safeURL(pick(paper.URL, paper.url, paper.SourceURL)),
    Type: pick(paper.Type, paper.type),
    sources: [source]
  });
  const titleKey = paper => normalizedTitle(paper.Title) + '|' + text(paper.Year);
  const mergePublications = (manual, imported) => {
    const merged = [], byDOI = new Map(), byTitle = new Map();
    for (const [items, source] of [[list(manual), 'manual'], [list(imported), 'orcid']]) {
      for (const raw of items) {
        const paper = normalizePaper(raw, source);
        if (!paper.Title || paper.Type === 'patent') continue;
        const key = titleKey(paper);
        let existing = paper.DOI ? byDOI.get(paper.DOI) : undefined;
        if (!existing && normalizedTitle(paper.Title)) {
          const titleMatch = byTitle.get(key);
          // A shared title cannot override two distinct DOI identities.
          if (titleMatch && (!titleMatch.DOI || !paper.DOI)) existing = titleMatch;
        }
        if (existing) {
          for (const [field, value] of Object.entries(paper)) {
            if (field === 'sources') continue;
            if ((existing[field] === undefined || existing[field] === null || existing[field] === '') && value !== undefined && value !== null && value !== '') existing[field] = value;
          }
          if (!existing.sources.includes(source)) existing.sources.push(source);
          if (existing.DOI) byDOI.set(existing.DOI, existing);
          byTitle.set(key, existing);
        } else {
          merged.push(paper);
          if (paper.DOI) byDOI.set(paper.DOI, paper);
          if (normalizedTitle(paper.Title)) byTitle.set(key, paper);
        }
      }
    }
    for (const paper of merged) if (!paper.Type) paper.Type = 'journal-article';
    return merged.sort((a, b) => order(b.Year, 0) - order(a.Year, 0) || order(a.DisplayOrder) - order(b.DisplayOrder) || a.Title.localeCompare(b.Title));
  };
  const selectedPublications = (site, merged) => {
    const manual = list(site.publications);
    const hasFlags = manual.some(paper => Object.prototype.hasOwnProperty.call(paper, 'Representative'));
    const selection = hasFlags ? manual.filter(paper => truthy(paper.Representative)) : list(site.representative_publications);
    const seen = new Set();
    return selection.map((paper, index) => {
      const normalized = normalizePaper(paper, 'manual');
      if (!normalized.Type) normalized.Type = 'journal-article';
      const match = merged.find(item => normalized.DOI && item.DOI === normalized.DOI) || merged.find(item => titleKey(item) === titleKey(normalized));
      return { paper: match || normalized, position: order(paper.RepresentativeOrder, order(paper.DisplayOrder, index)) };
    }).sort((a, b) => a.position - b.position).map(item => item.paper).filter(paper => {
      const key = paper.DOI || titleKey(paper);
      if (!paper.Title || seen.has(key)) return false;
      seen.add(key); return true;
    });
  };
  const bibText = value => text(value).replace(/[{}\\]/g, '').replace(/\s+/g, ' ');
  const bibtex = papers => papers.map((paper, index) => {
    const key = 'Tang' + (paper.Year || 'Undated') + '_' + (index + 1);
    const fields = [['title', paper.Title], ['author', paper.Authors ? paper.Authors.replace(/,\s*/g, ' and ').replace(/\.$/, '') : ''], ['journal', paper.Journal], ['year', paper.Year], ['doi', paper.DOI], ['url', paper.URL || doiURL(paper.DOI)]];
    return '@' + (paper.Type === 'conference-paper' ? 'inproceedings' : paper.Type === 'journal-article' ? 'article' : 'misc') + '{' + key + ',\n' + fields.filter(([, value]) => text(value)).map(([field, value]) => '  ' + field + ' = {' + bibText(value) + '}').join(',\n') + '\n}';
  }).join('\n\n') + '\n';

  const api = { normalizeDOI, normalizedTitle, safeURL, doiURL, mergePublications, selectedPublications, bibtex, paperTypeLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const node = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = text(content);
    return element;
  };
  const externalLink = (label, url, className) => {
    const href = safeURL(url);
    if (!href) return null;
    const link = node('a', className, label);
    link.href = href;
    if (!href.startsWith('mailto:')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    return link;
  };
  const putText = (id, content) => { $(id).textContent = text(content); };
  const sortRows = rows => list(rows).slice().sort((a, b) => order(a.Order) - order(b.Order));
  const renderEmpty = (container, message, tag = 'p') => container.replaceChildren(node(tag, 'empty', message));
  const formatDate = value => {
    const raw = text(value);
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(date);
  };
  const state = { site: {}, orcid: {}, papers: [], selected: [], visible: 12, selectedExpanded: false, orcidError: false, ready: false };

  function renderProfile(profile, github) {
    putText('nameCN', profile.name_cn || '学术主页');
    putText('nameEN', profile.name_en);
    putText('brandName', pick(profile.name_en).split(',')[0] || profile.name_cn);
    putText('titleLine', profile.title_line);
    putText('researchDirection', profile.research_direction);
    putText('profileText', profile.profile);
    putText('footerName', [text(profile.name_cn), pick(profile.name_en).split(',')[0]].filter(Boolean).join(' · '));
    document.title = [profile.name_cn, pick(profile.name_en).split(',')[0]].filter(Boolean).join(' · ') + ' | 学术主页';
    const links = [];
    const email = text(profile.email);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) links.push(['联系我 ↗', 'mailto:' + email, 'button light']);
    const orcid = text(profile.orcid).replace(/^https?:\/\/orcid\.org\//i, '');
    if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) links.push(['ORCID ↗', 'https://orcid.org/' + orcid, 'button ghost']);
    const owner = text(github.owner);
    if (/^[a-z\d-]+$/i.test(owner)) links.push(['GitHub ↗', 'https://github.com/' + owner, 'button ghost']);
    $('heroLinks').replaceChildren(...links.map(([label, url, cls]) => externalLink(label, url, cls)).filter(Boolean));
    const contactLinks = [];
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) contactLinks.push(externalLink(email + ' ↗', 'mailto:' + email));
    for (const [label, url] of links.filter(([, url]) => !url.startsWith('mailto:'))) contactLinks.push(externalLink(label, url, 'secondary'));
    $('contactLinks').replaceChildren(...contactLinks.filter(Boolean));
  }

  function renderMetrics() {
    const projects = list(state.site.projects);
    const grants = projects.filter(project => text(project.Category) !== '开放代码' && !/开源|开放代码/.test(text(project.FundingType)));
    const values = [[state.papers.length, '论文条目', '去重收录'], [state.selected.length, '代表论文', '人工精选'], [grants.length, '科研项目', '主页收录'], [list(state.site.patents).length, '授权专利', '主页收录']];
    $('metrics').replaceChildren(...values.map(([count, label, hint]) => {
      const item = node('div', 'metric');
      const description = node('p', 'metric-label', label);
      description.append(node('span', '', hint));
      item.append(node('div', 'metric-number', count), description);
      return item;
    }));
  }

  function renderResearch() {
    const rows = sortRows(state.site.research);
    if (!rows.length) return renderEmpty($('researchList'), '研究方向尚未添加。');
    $('researchList').replaceChildren(...rows.map((row, index) => {
      const item = node('article', 'research-item');
      item.append(node('span', 'research-number', String(index + 1).padStart(2, '0')), node('p', '', pick(row.Text, row.Title)));
      return item;
    }));
  }

  function renderEducation() {
    const rows = sortRows(state.site.education);
    if (!rows.length) return renderEmpty($('educationList'), '工作与教育经历尚未添加。');
    $('educationList').replaceChildren(...rows.map(row => {
      const item = node('article', 'timeline-item'), content = node('div', 'timeline-content');
      content.append(node('h3', '', row.MainText));
      if (text(row.Detail)) content.append(node('p', '', row.Detail));
      item.append(node('p', 'timeline-date', row.Date), content);
      return item;
    }));
  }

  function paperElement(paper, index, selected) {
    const item = node('li', 'paper-item'), year = node('div', 'paper-year', paper.Year || '年份未注明'), content = node('article', 'paper-content');
    year.append(node('span', 'paper-index', (selected ? 'SELECTED ' : 'NO. ') + String(index + 1).padStart(2, '0')));
    const title = node('h3');
    const link = externalLink(paper.Title, doiURL(paper.DOI) || paper.URL);
    title.append(link || node('span', '', paper.Title));
    content.append(title);
    if (paper.Authors) content.append(node('p', 'paper-authors', paper.Authors));
    const journal = node('p', 'paper-journal');
    if (paper.Journal) journal.append(node('strong', '', paper.Journal));
    const detail = text(paper.PublicationDetail);
    if (detail) journal.append(document.createTextNode(detail.startsWith(',') || detail.startsWith('，') ? detail : ' · ' + detail));
    else if (paper.Year) journal.append(document.createTextNode((paper.Journal ? ' · ' : '') + paper.Year));
    if (journal.textContent) content.append(journal);
    const tags = node('div', 'paper-tags');
    if (text(paper.AuthorRole) && text(paper.AuthorRole) !== '其他') tags.append(node('span', 'paper-tag role', paper.AuthorRole));
    if (paper.Type !== 'journal-article') tags.append(node('span', 'paper-tag', paperTypeLabel(paper.Type)));
    const status = pick(paper.Status, paper.status);
    if (status && !['published', '已发表', '正式发表'].includes(status.toLowerCase())) {
      const label = ({accepted: '已接收', 'in press': '待刊', 'in-press': '待刊', inpress: '待刊', submitted: '已投稿', 'under review': '审稿中', preprint: '预印本'})[status.toLowerCase()] || status;
      tags.append(node('span', 'paper-tag', label));
    }
    if (text(paper.CAS_Zone) && !['未收录', '无'].includes(text(paper.CAS_Zone))) tags.append(node('span', 'paper-tag', '中科院 ' + text(paper.CAS_Zone) + (truthy(paper.CAS_TOP) ? ' · TOP' : '')));
    if (paper.sources.includes('orcid')) tags.append(node('span', 'paper-source', paper.sources.includes('manual') ? 'ORCID 已关联' : 'ORCID 同步'));
    const paperURL = doiURL(paper.DOI) || paper.URL;
    if (paperURL) tags.append(externalLink(paper.DOI ? 'DOI ↗' : '论文链接 ↗', paperURL, 'paper-link'));
    const codeURL = safeURL(pick(paper.code_url, paper.CodeURL));
    if (codeURL) tags.append(externalLink('代码 ↗', codeURL, 'paper-link'));
    if (tags.children.length) content.append(tags);
    if (text(paper.description || paper.Description)) content.append(node('p', 'paper-authors', pick(paper.description, paper.Description)));
    item.append(year, content);
    return item;
  }

  function renderSelected() {
    const papers = state.selectedExpanded ? state.selected : state.selected.slice(0, 4);
    if (!papers.length) renderEmpty($('selectedList'), '暂无代表性论文。', 'li');
    else $('selectedList').replaceChildren(...papers.map((paper, index) => paperElement(paper, index, true)));
    $('selectedMore').hidden = state.selected.length <= 4 || state.selectedExpanded;
    $('selectedMore').textContent = '查看全部 ' + state.selected.length + ' 篇代表论文 ↓';
  }

  function filteredPapers() {
    const search = $('paperSearch').value.trim().toLowerCase();
    const year = $('paperYear').value, type = $('paperType').value;
    return state.papers.filter(paper => (!year || paper.Year === year) && (!type || paper.Type === type) && (!search || [paper.Title, paper.Authors, paper.Journal, paper.DOI].join(' ').toLowerCase().includes(search)));
  }

  function renderPapers() {
    const papers = filteredPapers(), visible = papers.slice(0, state.visible);
    if (!papers.length) {
      const empty = node('li', 'empty', state.papers.length ? '没有找到符合条件的论文。' : '暂无论文条目。');
      if (state.papers.length) {
        empty.append(node('span', 'empty-hint', '试试其他关键词，或清除年份与类型筛选。'));
        const reset = node('button', 'button outline', '清除筛选');
        reset.type = 'button'; reset.addEventListener('click', resetFilters); empty.append(reset);
      }
      $('publicationList').replaceChildren(empty);
    } else $('publicationList').replaceChildren(...visible.map((paper, index) => paperElement(paper, index, false)));
    putText('paperCount', '共 ' + state.papers.length + ' 条论文记录 · 筛选结果 ' + papers.length + ' 条 · 已显示 ' + visible.length + ' 条');
    $('showMore').hidden = visible.length >= papers.length;
    $('showMore').textContent = '加载更多论文（还有 ' + Math.max(0, papers.length - visible.length) + ' 条） ↓';
    $('exportBibtex').disabled = !papers.length;
  }

  function fillFilters() {
    const years = [...new Set(state.papers.map(paper => paper.Year).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
    const types = [...new Set(state.papers.map(paper => paper.Type))];
    $('paperYear').replaceChildren(new Option('全部年份', ''), ...years.map(year => new Option(year, year)));
    $('paperType').replaceChildren(new Option('全部类型', ''), ...types.map(type => new Option(paperTypeLabel(type), type)));
  }

  function renderProjects() {
    const rows = sortRows(state.site.projects);
    if (!rows.length) return renderEmpty($('projectList'), '暂无项目记录。');
    $('projectList').replaceChildren(...rows.map(row => {
      const code = text(row.Category) === '开放代码' || /开源|开放代码/.test(text(row.FundingType));
      const item = node('article', 'project-item' + (code ? ' code' : ''));
      item.append(node('p', 'project-category', pick(row.Category, row.FundingType, '科研项目')), node('h3', '', pick(row.ProjectName, row.Title)));
      const funding = text(row.FundingType);
      if (funding && funding !== pick(row.Category, row.FundingType)) item.append(node('p', 'project-description', funding));
      if (text(row.Description)) item.append(node('p', 'project-description', row.Description));
      const meta = node('p', 'project-meta');
      const dates = [text(row.Start), text(row.End)].filter(Boolean).join(' — ');
      if (dates) meta.append(node('span', '', dates));
      if (text(row.Number)) meta.append(node('span', '', 'No. ' + text(row.Number)));
      if (text(row.AmountWan)) meta.append(node('span', '', text(row.AmountWan) + ' 万元'));
      if (meta.children.length) item.append(meta);
      const url = safeURL(pick(row.SourceURL, row.URL, row.code_url));
      if (url) item.append(externalLink(code ? '查看代码与复现说明 ↗' : '查看项目 ↗', url, 'project-link'));
      return item;
    }));
  }

  function renderDetails(id, rows, type) {
    const container = $(id), entries = sortRows(rows);
    if (!entries.length) return renderEmpty(container, '暂无记录。', 'li');
    container.replaceChildren(...entries.map((row, index) => {
      const item = node('li', 'detail-item'), content = node('div');
      item.append(node('span', 'detail-number', String(index + 1).padStart(2, '0')));
      if (type === 'patent' && text(row.Title)) {
        content.append(node('h3', '', row.Title));
        const meta = [text(row.Role), text(row.PatentNo), text(row.GrantDate) ? '授权日期：' + text(row.GrantDate) : ''].filter(Boolean).join(' · ');
        if (meta) content.append(node('p', 'detail-meta', meta));
      } else content.append(node('p', '', pick(row.DisplayText, row.Text, row.Title)));
      const link = externalLink('相关链接 ↗', pick(row.SourceURL, row.URL), 'paper-link');
      if (link) content.append(link);
      item.append(content); return item;
    }));
  }

  function renderSync() {
    const container = $('syncInfo');
    const importedCount = list(state.orcid.publications).length;
    const orcidCount = state.papers.filter(paper => paper.sources.includes('orcid')).length;
    const synced = formatDate(state.orcid.last_sync);
    container.replaceChildren();
    if (state.orcidError) {
      container.append(document.createTextNode('ORCID 同步记录暂时无法读取，当前显示已维护的论文资料。'));
      const retry = node('button', 'text-button', '重新读取');
      retry.type = 'button'; retry.addEventListener('click', loadData); container.append(retry);
    } else if (synced) container.append(document.createTextNode('ORCID 最近同步：' + synced + ' · 获取 ' + importedCount + ' 条公开论文，去重关联 ' + orcidCount + ' 条。'));
    else container.append(document.createTextNode('ORCID 同步尚未完成，当前显示已维护的论文资料。'));
    const source = externalLink('查看 ORCID ↗', state.orcid.source_url || ('https://orcid.org/' + text(state.site.profile && state.site.profile.orcid)));
    if (source) { container.append(document.createTextNode(' ')); container.append(source); }
  }

  async function fetchJSON(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid data');
      return data;
    } finally { clearTimeout(timeout); }
  }

  async function loadData() {
    $('dataStatus').className = 'container status-region';
    $('dataStatus').replaceChildren(node('span', 'status-dot'), document.createTextNode('正在加载学术资料…'));
    const [manualResult, orcidResult] = await Promise.allSettled([fetchJSON('data/site.json'), fetchJSON('data/orcid.json')]);
    if (manualResult.status === 'rejected') {
      $('dataStatus').classList.add('error');
      $('dataStatus').replaceChildren(document.createTextNode('主页资料加载失败，请检查网络后重试。'));
      const retry = node('button', 'retry', '重新加载'); retry.type = 'button'; retry.addEventListener('click', loadData); $('dataStatus').append(retry);
      if (!state.ready) {
        for (const id of ['researchList', 'educationList', 'projectList']) renderEmpty($(id), '资料未加载，请使用上方“重新加载”。');
        for (const id of ['selectedList', 'publicationList', 'patentList', 'awardList', 'serviceList']) renderEmpty($(id), '资料未加载，请使用上方“重新加载”。', 'li');
        putText('paperCount', '论文资料暂时无法读取。'); putText('syncInfo', '同步记录未加载。'); putText('updatedAt', '资料加载失败');
      }
      return;
    }
    state.site = manualResult.value;
    state.orcid = orcidResult.status === 'fulfilled' ? orcidResult.value : {};
    state.orcidError = orcidResult.status === 'rejected';
    state.papers = mergePublications(state.site.publications, state.orcid.publications);
    state.selected = selectedPublications(state.site, state.papers);
    state.visible = 12; state.selectedExpanded = false; state.ready = true;
    renderProfile(state.site.profile || {}, state.site.github || {});
    renderMetrics(); renderResearch(); renderEducation(); renderSelected(); fillFilters(); renderPapers(); renderProjects();
    renderDetails('patentList', state.site.patents, 'patent');
    renderDetails('awardList', state.site.awards, 'award');
    renderDetails('serviceList', state.site.service, 'service');
    renderSync();
    const date = formatDate(state.site.updated_at);
    putText('updatedAt', date ? '主页资料更新：' + date : '个人维护的学术资料');
    $('dataStatus').replaceChildren(node('span', 'status-dot'), document.createTextNode('主页收录 ' + state.papers.length + ' 条论文记录 · ' + (state.orcidError ? 'ORCID 记录暂时无法读取' : '论文目录结合人工维护与 ORCID 公开记录')));
  }

  function resetFilters() {
    $('paperSearch').value = ''; $('paperYear').value = ''; $('paperType').value = '';
    state.visible = 12; renderPapers();
  }
  function init() {
    $('navToggle').addEventListener('click', () => {
      const expanded = $('navToggle').getAttribute('aria-expanded') === 'true';
      $('navToggle').setAttribute('aria-expanded', String(!expanded)); $('siteNav').classList.toggle('open', !expanded);
    });
    $('siteNav').addEventListener('click', event => {
      if (event.target.closest('a')) { $('siteNav').classList.remove('open'); $('navToggle').setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('siteNav').classList.remove('open'); $('navToggle').setAttribute('aria-expanded', 'false'); } });
    $('paperFilters').addEventListener('submit', event => event.preventDefault());
    $('paperFilters').addEventListener('reset', event => { event.preventDefault(); resetFilters(); });
    $('paperSearch').addEventListener('input', () => { state.visible = 12; renderPapers(); });
    for (const id of ['paperYear', 'paperType']) $(id).addEventListener('change', () => { state.visible = 12; renderPapers(); });
    $('showMore').addEventListener('click', () => { const previous = state.visible; state.visible += 12; renderPapers(); const next = $('publicationList').children[previous]; if (next) { const link = next.querySelector('a'); if (link) link.focus({ preventScroll: true }); } });
    $('selectedMore').addEventListener('click', () => { state.selectedExpanded = true; renderSelected(); const link = $('selectedList').children[4] && $('selectedList').children[4].querySelector('a'); if (link) link.focus({ preventScroll: true }); });
    $('exportBibtex').addEventListener('click', () => {
      const blob = new Blob([bibtex(filteredPapers())], { type: 'application/x-bibtex;charset=utf-8' });
      const url = URL.createObjectURL(blob), link = node('a');
      link.href = url; link.download = 'qiang-tang-publications.bib'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) for (const link of $('siteNav').querySelectorAll('a')) link.classList.toggle('active', link.hash === '#' + entry.target.id);
      }, { rootMargin: '-18% 0px -65% 0px', threshold: 0 });
      for (const id of ['research', 'experience', 'publications', 'projects', 'contact']) observer.observe($(id));
    }
    loadData();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
