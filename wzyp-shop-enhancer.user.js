// ==UserScript==
// @name         链动小铺：隐藏缺货、价格排序、回车搜索
// @namespace    local.wzyp.shop-enhancer
// @version      1.0.3
// @description  店铺商品默认隐藏缺货，支持按售价排序，以及在原搜索框按回车搜索。
// @match        https://wzyp.cn/shop/*
// @match        http://wzyp.cn/shop/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    'use strict';

    let showSoldOut = false;
    let sortMode = 'original';
    let scheduled = false;
    let settingsKey = '';
    let refreshingUntil = 0;
    let refreshingLoadingSeen = false;

    function loadSettings() {
        const key = `shop-settings:${location.pathname.split('/')[2]}`;
        if (key === settingsKey) return;
        settingsKey = key;
        const saved = GM_getValue(key, {});
        showSoldOut = saved?.showSoldOut === true;
        sortMode = ['original', 'asc', 'desc'].includes(saved?.sortMode) ? saved.sortMode : 'original';
    }

    function saveSettings() {
        GM_setValue(settingsKey, { showSoldOut, sortMode });
    }

    const style = document.createElement('style');
    style.textContent = `
        .wzyp-tools {
            display: flex; align-items: center; flex-wrap: wrap; gap: 12px;
            margin: 0 0 16px; padding: 12px;
            background: var(--color-bg-2, #fff); color: var(--color-text-2, #333);
            border: 1px solid var(--color-border-2, #e5e6eb); border-radius: 8px;
            font-size: 13px;
        }
        .wzyp-tools label { display: inline-flex; align-items: center; gap: 6px; }
        .wzyp-tools input { margin: 0; accent-color: #165dff; }
        .wzyp-tools select {
            padding: 5px 8px; border: 1px solid #c9cdd4; border-radius: 4px;
            background: var(--color-bg-2, #fff); color: inherit;
        }
        .wzyp-tools .wzyp-summary { color: var(--color-text-3, #666); }
        .wzyp-refresh {
            display: inline-flex; align-items: center; justify-content: center;
            width: 30px; height: 30px; padding: 5px; cursor: pointer;
            border: 1px solid #c9cdd4; border-radius: 4px;
            background: var(--color-bg-2, #fff); color: inherit;
        }
        .wzyp-refresh:disabled { opacity: .45; cursor: default; }
        .goods-list.wzyp-list { display: flex !important; flex-direction: column; }
        .goods-list > .wzyp-tools { order: -1; }
        .goods_content .wzyp-grid {
            display: grid !important;
            grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
            gap: 12px; height: auto !important; width: 100%;
        }
        .goods_content .wzyp-grid > .goods_item {
            position: relative !important; inset: auto !important;
            transform: none !important; width: auto !important; min-width: 0 !important;
            margin: 0 !important; box-sizing: border-box; align-self: start;
        }
        .goods_content .goods_item.wzyp-sold-out,
        .goods-list .goods-item.wzyp-sold-out { display: none !important; }
    `;
    document.head.append(style);

    function priceOf(card) {
        const price = card.querySelector('.goods-price .nowPrice');
        if (!price && card.querySelector('.goods-price .free')) return 0;
        const text = price?.textContent.trim().replace(/[,，\s]/g, '') ?? '';
        return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
    }

    function isSoldOut(card) {
        const stock = card.querySelector('.stock');
        return Boolean(stock && (stock.classList.contains('rank0') ||
            /^(缺货|售罄|已售罄|无库存)$/.test(stock.textContent.trim())));
    }

    function refreshTarget(content) {
        const scope = content.closest('.page_content, .page-goods');
        const category = scope?.querySelector('.arco-menu-selected, .fl_box_leng_xz, .category_list .category.active');
        if (category) return category;
        const search = document.querySelector('input[placeholder="搜索商品"]');
        return search?.value.trim() ? search.closest('.arco-input-search')
            ?.querySelector('.arco-input-suffix .arco-icon-hover') : null;
    }

    function makeToolbar(content) {
        const bar = document.createElement('div');
        bar.className = 'wzyp-tools';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', '商品筛选与排序');
        bar.innerHTML = `
            <label><input type="checkbox" class="wzyp-show-stock">显示缺货商品</label>
            <label>价格排序
                <select class="wzyp-sort" aria-label="价格排序">
                    <option value="original">默认排序</option>
                    <option value="asc">价格从低到高</option>
                    <option value="desc">价格从高到低</option>
                </select>
            </label>
            <button type="button" class="wzyp-refresh" title="刷新当前分类" aria-label="刷新当前分类">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M20 7v5h-5M4 17v-5h5M5.6 7a7 7 0 0 1 11.9-1L20 9M4 15l2.5 3A7 7 0 0 0 18.4 17" />
                </svg>
            </button>
            <span class="wzyp-summary" role="status"></span>
            <small>筛选和排序针对已加载商品；点击原站“加载更多”后自动更新。</small>
        `;
        bar.querySelector('input').addEventListener('change', event => {
            loadSettings();
            showSoldOut = event.target.checked;
            saveSettings();
            schedule();
        });
        bar.querySelector('select').addEventListener('change', event => {
            loadSettings();
            sortMode = event.target.value;
            saveSettings();
            schedule();
        });
        bar.querySelector('.wzyp-refresh').addEventListener('click', event => {
            const target = refreshTarget(content);
            if (!target) return;
            event.currentTarget.disabled = true;
            refreshingUntil = Date.now() + 500;
            refreshingLoadingSeen = false;
            target.click();
            schedule();
            window.setTimeout(schedule, 550);
        });
        content.prepend(bar);
        return bar;
    }

    function render() {
        scheduled = false;
        observer.disconnect();
        try {
            if (!location.pathname.startsWith('/shop/')) return;
            loadSettings();
            for (const content of document.querySelectorAll('.goods_content, .goods-list')) {
                const bar = content.querySelector('.wzyp-tools') || makeToolbar(content);
                bar.querySelector('input').checked = showSoldOut;
                bar.querySelector('select').value = sortMode;
                const refresh = bar.querySelector('.wzyp-refresh');
                const loading = Boolean(content.closest('.page_content, .page-goods')
                    ?.querySelector('.loading-three-colomns-container'));
                if (loading) refreshingLoadingSeen = true;
                else if (refreshingLoadingSeen) refreshingUntil = 0;
                refresh.disabled = loading || refreshingUntil > Date.now() || !refreshTarget(content);
                refresh.setAttribute('aria-busy', String(loading));
                const cards = [...content.querySelectorAll('.goods_item, .goods-item')];
                const groups = new Map();
                let hidden = 0;
                for (const card of cards) {
                    const hide = !showSoldOut && isSoldOut(card);
                    card.classList.toggle('wzyp-sold-out', hide);
                    if (hide) hidden++;
                    const parent = card.parentElement;
                    if (!groups.has(parent)) groups.set(parent, []);
                    groups.get(parent).push(card);
                }
                for (const [parent, items] of groups) {
                    parent.classList.add(items[0].matches('.goods-item') ? 'wzyp-list' : 'wzyp-grid');
                    // CSS order keeps Vue's DOM order and original click handlers intact.
                    const sorted = items.map((card, index) => ({ card, index, price: priceOf(card) }));
                    if (sortMode !== 'original') {
                        sorted.sort((a, b) => {
                            if (a.price === null && b.price === null) return a.index - b.index;
                            if (a.price === null) return 1;
                            if (b.price === null) return -1;
                            const delta = sortMode === 'asc' ? a.price - b.price : b.price - a.price;
                            return delta || a.index - b.index;
                        });
                    }
                    sorted.forEach(({ card }, index) => {
                        card.style.order = String(index);
                    });
                }
                const summary = `已加载 ${cards.length} 件，显示 ${cards.length - hidden} 件，隐藏缺货 ${hidden} 件`;
                const status = bar.querySelector('.wzyp-summary');
                if (status.textContent !== summary) status.textContent = summary;
            }
        } finally {
            observer.observe(document.body, {
                childList: true, subtree: true, characterData: true,
                attributes: true, attributeFilter: ['class'],
            });
        }
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(render);
    }

    // Delegate to the site's own search action, including its category/paging reset.
    document.addEventListener('keydown', event => {
        if (!location.pathname.startsWith('/shop/') || event.key !== 'Enter' ||
            event.isComposing || event.keyCode === 229 || event.repeat) return;
        if (!(event.target instanceof HTMLInputElement) ||
            !event.target.matches('input[placeholder="搜索商品"]')) return;
        const wrapper = event.target.closest('.arco-input-search');
        const trigger = wrapper?.querySelector('.arco-input-suffix .arco-icon-hover');
        if (!trigger) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        trigger.click();
    }, true);

    const observer = new MutationObserver(schedule);
    render();
})();
