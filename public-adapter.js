(function () {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const CONFIG_KEY = "stock-discipline-public-config-v1";
  const JOURNAL_KEY = "stock-discipline-public-journal-v1";
  const adapterBase = new URL("./", document.currentScript.src);
  const cache = new Map();
  let lastQuotes = null;

  const defaultsPromise = Promise.all([
    nativeFetch(new URL("defaults/watchlist.json", adapterBase), { cache: "no-store" }).then((response) => response.json()),
    nativeFetch(new URL("defaults/journal.json", adapterBase), { cache: "no-store" }).then((response) => response.json()),
  ]).then(([config, journal]) => ({ config, journal }));

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function number(value) {
    if (value === null || value === undefined || value === "" || value === "-") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function positive(value) {
    const parsed = number(value);
    return parsed !== null && parsed > 0 ? parsed : null;
  }

  function scaledPrice(value) {
    const parsed = positive(value);
    return parsed === null ? null : parsed / 100;
  }

  function pct(price, previous) {
    return price === null || previous === null || !previous ? null : (price - previous) / previous * 100;
  }

  function market(code) {
    return /^(5|60|68|90)/.test(code) ? 1 : 0;
  }

  function secid(code) {
    return `${market(code)}.${code}`;
  }

  function emCode(code) {
    return `${market(code) ? "SH" : "SZ"}${code}`;
  }

  function tencentSymbol(code) {
    return `${market(code) ? "sh" : "sz"}${code}`;
  }

  function compactTime(value) {
    const raw = String(value || "");
    if (!/^\d{14}$/.test(raw)) return null;
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
  }

  function nowText() {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  }

  async function cached(key, ttl, loader) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await loader();
    cache.set(key, { expires: Date.now() + ttl, value });
    return value;
  }

  function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  async function loadStored(key, defaultKey) {
    const defaults = await defaultsPromise;
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return clone(defaults[defaultKey]);
      const parsed = JSON.parse(stored);
      const defaultValue = defaults[defaultKey];
      if (defaultKey === "config") {
        const storedRevision = number(parsed?.state_revision) || 0;
        const defaultRevision = number(defaultValue?.state_revision) || 0;
        if (defaultRevision > storedRevision) return clone(defaultValue);
      }
      const storedVersion = defaultKey === "config" ? parsed?.account?.snapshot_time : parsed?.updated_at;
      const defaultVersion = defaultKey === "config" ? defaultValue?.account?.snapshot_time : defaultValue?.updated_at;
      return defaultVersion && (!storedVersion || String(defaultVersion) > String(storedVersion))
        ? clone(defaultValue)
        : parsed;
    } catch {
      return clone(defaults[defaultKey]);
    }
  }

  function jsonp(url, callbackParameter = "cb") {
    return new Promise((resolve, reject) => {
      const callback = `__stockJsonp${Date.now()}${Math.random().toString(16).slice(2)}`;
      const target = new URL(url);
      target.searchParams.set(callbackParameter, callback);
      const script = document.createElement("script");
      const timer = setTimeout(() => finish(new Error("行情请求超时")), 12000);
      function finish(error, value) {
        clearTimeout(timer);
        script.remove();
        try { delete window[callback]; } catch {}
        error ? reject(error) : resolve(value);
      }
      window[callback] = (value) => finish(null, value);
      script.onerror = () => finish(new Error("行情脚本加载失败"));
      script.src = target.toString();
      document.head.appendChild(script);
    });
  }

  function scriptVariable(url, variableName) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => finish(new Error("期货行情请求超时")), 12000);
      function finish(error) {
        clearTimeout(timer);
        script.remove();
        const value = window[variableName];
        try { delete window[variableName]; } catch {}
        error ? reject(error) : resolve(value);
      }
      try { delete window[variableName]; } catch {}
      script.onload = () => finish(window[variableName] === undefined ? new Error("期货行情为空") : null);
      script.onerror = () => finish(new Error("期货行情加载失败"));
      script.src = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
      document.head.appendChild(script);
    });
  }

  async function fetchQuotes(stocks) {
    return cached("quotes", 4000, async () => {
      try {
        const symbols = stocks.map((stock) => tencentSymbol(String(stock.code)));
        const response = await nativeFetch(`https://qt.gtimg.cn/q=${symbols.join(",")}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`腾讯行情返回 ${response.status}`);
        const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
        const rows = new Map();
        for (const match of text.matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/g)) {
          rows.set(match[1], match[2].split("~"));
        }
        const result = new Map();
        for (const stock of stocks) {
          const code = String(stock.code);
          const fields = rows.get(tencentSymbol(code));
          if (!fields) continue;
          let price = positive(fields[3]);
          const previous = positive(fields[4]);
          let fallback = false;
          let note = null;
          if (price === null && previous !== null) {
            price = previous;
            fallback = true;
            note = "行情源暂未返回有效现价，当前按昨收参考，不触发提醒。";
          }
          result.set(code, {
            code,
            name: stock.name || fields[1] || code,
            price,
            prev_close: previous,
            open_price: positive(fields[5]),
            high: positive(fields[33]),
            low: positive(fields[34]),
            volume: number(fields[36]),
            amount: number(fields[37]) === null ? null : number(fields[37]) * 10000,
            quote_time: compactTime(fields[30]),
            source: fallback ? "腾讯证券昨收参考" : "腾讯证券实时行情",
            fallback,
            error: note,
          });
        }
        for (const stock of stocks) {
          const code = String(stock.code);
          if (result.has(code)) continue;
          const snapshot = positive(stock.snapshot_price);
          result.set(code, {
            code,
            name: stock.name || code,
            price: snapshot,
            prev_close: snapshot,
            open_price: snapshot,
            high: snapshot,
            low: snapshot,
            volume: null,
            amount: null,
            quote_time: null,
            source: "最近持仓快照",
            fallback: true,
            error: "实时行情暂不可用",
          });
        }
        lastQuotes = result;
        return result;
      } catch (error) {
        const result = new Map();
        for (const stock of stocks) {
          const code = String(stock.code);
          const previous = lastQuotes && lastQuotes.get(code);
          const snapshot = positive(stock.snapshot_price);
          result.set(code, previous ? {
            ...previous,
            fallback: true,
            source: `${previous.source}（最近成功）`,
            error: `实时刷新失败：${error.message}`,
          } : {
            code,
            name: stock.name || code,
            price: snapshot,
            prev_close: snapshot,
            open_price: snapshot,
            high: snapshot,
            low: snapshot,
            volume: null,
            amount: null,
            quote_time: null,
            source: "最近持仓快照",
            fallback: true,
            error: `实时行情暂不可用：${error.message}`,
          });
        }
        return result;
      }
    });
  }

  async function fetchLithium() {
    return cached("lithium", 5000, async () => {
      const [minuteResult, dailyResult] = await Promise.allSettled([
        lithiumChart("minute1"),
        lithiumChart("daily"),
      ]);
      const minuteRows = minuteResult.status === "fulfilled" ? minuteResult.value.rows : [];
      const dailyRows = dailyResult.status === "fulfilled" ? dailyResult.value.rows : [];
      const latestMinute = minuteRows.length ? minuteRows[minuteRows.length - 1] : null;
      const latestDaily = dailyRows.length ? dailyRows[dailyRows.length - 1] : null;
      const current = latestMinute || latestDaily;
      if (!current) {
        const errors = [minuteResult, dailyResult]
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason && result.reason.message)
          .filter(Boolean);
        return { code: "LC0", name: "碳酸锂连续", price: null, change_pct: null, source: "新浪期货行情", error: errors.join("；") || "碳酸锂行情为空" };
      }
      const currentDate = String(current.date || "").slice(0, 10);
      const sameDayMinutes = minuteRows.filter((row) => String(row.date || "").slice(0, 10) === currentDate);
      let previous = null;
      if (dailyRows.length) {
        const lastDailyDate = String(latestDaily.date || "").slice(0, 10);
        previous = lastDailyDate === currentDate && dailyRows.length > 1
          ? dailyRows[dailyRows.length - 2].close
          : latestDaily.close;
      }
      const open = sameDayMinutes.length ? sameDayMinutes[0].open : latestDaily && latestDaily.open;
      const high = sameDayMinutes.length ? Math.max(...sameDayMinutes.map((row) => row.high)) : latestDaily && latestDaily.high;
      const low = sameDayMinutes.length ? Math.min(...sameDayMinutes.map((row) => row.low)) : latestDaily && latestDaily.low;
      return {
        code: "LC0",
        name: "碳酸锂连续",
        price: current.close,
        change_pct: pct(current.close, previous),
        open,
        high,
        low,
        prev_close: previous,
        volume: sameDayMinutes.reduce((sum, row) => sum + (number(row.volume) || 0), 0) || number(current.volume),
        hold: number(current.hold),
        date: currentDate,
        time: String(current.date || ""),
        source: latestMinute ? "新浪期货1分钟行情" : "新浪期货日K行情",
        error: null,
      };
    });
  }

  function effectiveTrigger(stock) {
    const today = nowText().slice(0, 10);
    if (stock.post_dividend_from && number(stock.post_dividend_trigger_below) !== null && today >= stock.post_dividend_from) {
      return { trigger: number(stock.post_dividend_trigger_below), label: `除息后口径 ${stock.post_dividend_trigger_below}` };
    }
    return { trigger: number(stock.trigger_below), label: null };
  }

  function review(stock, quote, lithium) {
    const current = effectiveTrigger(stock);
    const strong = number(stock.strong_below);
    if (quote.fallback) return { level: "pending", title: "行情待确认", messages: [quote.error || "备用价格不触发提醒。"], trigger: current.trigger, strong, trigger_label: current.label };
    if (quote.price === null) return { level: "unknown", title: "行情异常", messages: [quote.error || "没有取得最新行情"], trigger: current.trigger, strong, trigger_label: current.label };
    let level = "normal";
    const messages = [];
    if (strong !== null && quote.price <= strong) {
      level = "strong";
      messages.push(`低于强复核线 ${strong}，只代表进入重点复核区，不构成买入建议。`);
    } else if (current.trigger !== null && quote.price <= current.trigger) {
      level = "watch";
      messages.push(`低于复核线 ${current.trigger}，需要结合最新财报、经营数据和市场环境判断。`);
    }
    if (String(stock.code) === "002466" && lithium.price !== null) {
      if (lithium.price <= 150000) {
        if (level === "normal") level = "risk";
        messages.push("碳酸锂已跌破15万元风险线，天齐锂业不适合继续加仓。");
      } else if (lithium.price < 155000) messages.push("碳酸锂仍在15.5万元下方，先按观察仓处理。");
      else messages.push("碳酸锂高于15.5万元，继续观察能否站稳16万元。");
    }
    if (!messages.length) messages.push("未触发价格复核线，维持观察。");
    const titles = { normal: "正常观察", watch: "进入复核区", strong: "强复核区", risk: "风险提示" };
    return { level, title: titles[level], messages, trigger: current.trigger, strong, trigger_label: current.label };
  }

  async function buildSnapshot() {
    const config = await loadStored(CONFIG_KEY, "config");
    const stocks = Array.isArray(config.stocks) ? config.stocks : [];
    const [quotes, lithium] = await Promise.all([fetchQuotes(stocks), fetchLithium()]);
    let totalMarketValue = 0;
    let totalCost = 0;
    let totalPnl = 0;
    let dayPnl = 0;
    let dayComplete = true;
    const rows = stocks.map((stock) => {
      const code = String(stock.code);
      const quote = quotes.get(code);
      const qty = Math.max(0, Math.trunc(number(stock.holding_qty) || 0));
      const cost = number(stock.holding_cost);
      let marketValue = null;
      let costValue = null;
      let holdingPnl = null;
      let holdingPnlPct = null;
      if (qty && quote.price !== null && cost !== null) {
        marketValue = qty * quote.price;
        costValue = qty * cost;
        holdingPnl = marketValue - costValue;
        holdingPnlPct = costValue ? holdingPnl / costValue * 100 : null;
        totalMarketValue += marketValue;
        totalCost += costValue;
        totalPnl += holdingPnl;
      }
      if (qty) {
        if (quote.price === null || quote.prev_close === null || quote.fallback) dayComplete = false;
        else dayPnl += qty * (quote.price - quote.prev_close);
      }
      return {
        code,
        name: stock.name || quote.name,
        category: stock.category,
        thesis: stock.thesis,
        price: quote.price,
        change_pct: pct(quote.price, quote.prev_close),
        prev_close: quote.prev_close,
        high: quote.high,
        low: quote.low,
        volume: quote.volume,
        amount: quote.amount,
        quote_time: quote.quote_time,
        source: quote.source,
        quote_fallback: quote.fallback,
        quote_note: quote.error,
        holding_qty: qty,
        holding_cost: cost,
        cost_value: costValue,
        market_value: marketValue,
        pnl: holdingPnl,
        pnl_pct: holdingPnlPct,
        review: review(stock, quote, lithium),
        review_points: stock.review_points || [],
        finance_url: `https://emweb.securities.eastmoney.com/PC_HSF10/FinanceAnalysis/Index?type=web&code=${emCode(code)}`,
      };
    });
    const accountConfig = config.account || {};
    const brokerAvailable = number(accountConfig.available_cash);
    const brokerAssets = number(accountConfig.total_assets);
    const portfolioCapital = number(accountConfig.portfolio_total_capital);
    const totalAssets = portfolioCapital !== null
      ? portfolioCapital
      : brokerAvailable !== null
        ? totalMarketValue + brokerAvailable
        : brokerAssets;
    const available = totalAssets !== null ? Math.max(0, totalAssets - totalMarketValue) : brokerAvailable;
    return {
      as_of: nowText(),
      refresh_seconds: Math.max(5, number(config.refresh_seconds) || 15),
      account: {
        source: "公开移动版/浏览器本地配置",
        snapshot_time: accountConfig.snapshot_time,
        total_assets: totalAssets,
        broker_total_assets: brokerAssets,
        day_pnl: dayComplete ? dayPnl : number(accountConfig.day_pnl),
        broker_day_pnl: number(accountConfig.day_pnl),
        day_pnl_method: dayComplete ? "previous_close_estimate" : "broker_snapshot",
        day_pnl_note: dayComplete ? "按实时价与昨收价动态估算。" : "行情不完整，显示最近券商截图。",
        broker_holding_pnl: number(accountConfig.holding_pnl),
        market_value: totalMarketValue,
        broker_market_value: number(accountConfig.market_value),
        available_cash: available,
        broker_available_cash: brokerAvailable,
        withdrawable_cash: number(accountConfig.withdrawable_cash),
        position_ratio: totalAssets ? totalMarketValue / totalAssets * 100 : number(accountConfig.position_ratio),
        broker_position_ratio: number(accountConfig.position_ratio),
      },
      positions: { cost: totalCost, market_value: totalMarketValue, pnl: totalPnl, pnl_pct: totalCost ? totalPnl / totalCost * 100 : null },
      lithium,
      stocks: rows,
    };
  }

  function parseKline(raw) {
    const fields = raw.split(",");
    return { date: fields[0], open: number(fields[1]), close: number(fields[2]), high: number(fields[3]), low: number(fields[4]), volume: number(fields[5]), amount: number(fields[6]), amplitude: number(fields[7]), pct: number(fields[8]), change: number(fields[9]), turnover: number(fields[10]) };
  }

  function parseTrend(raw) {
    const fields = raw.split(",");
    return { time: fields[0], open: number(fields[1]), close: number(fields[2]), high: number(fields[3]), low: number(fields[4]), volume: number(fields[5]), amount: number(fields[6]), avg_price: number(fields[7]) };
  }

  async function stockChart(code, requested) {
    const type = ["intraday", "daily", "weekly", "monthly"].includes(requested) ? requested : "daily";
    return cached(`chart:${code}:${type}`, type === "intraday" ? 5000 : 300000, async () => {
      const symbol = tencentSymbol(code);
      if (type === "intraday") {
        const response = await nativeFetch(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`腾讯分时返回 ${response.status}`);
        const payload = await response.json();
        const result = payload && payload.data && payload.data[symbol];
        if (!result || !result.data) throw new Error("腾讯分时行情为空");
        const date = String(result.data.date || "");
        let previousVolume = 0;
        let previousAmount = 0;
        const rows = (result.data.data || []).map((raw) => {
          const fields = String(raw).trim().split(/\s+/);
          const price = number(fields[1]);
          const cumulativeVolume = number(fields[2]) || previousVolume;
          const cumulativeAmount = number(fields[3]) || previousAmount;
          const volume = Math.max(0, cumulativeVolume - previousVolume);
          const amount = Math.max(0, cumulativeAmount - previousAmount);
          previousVolume = cumulativeVolume;
          previousAmount = cumulativeAmount;
          const clock = String(fields[0] || "").padStart(4, "0");
          const time = /^\d{8}$/.test(date)
            ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${clock.slice(0, 2)}:${clock.slice(2, 4)}`
            : clock;
          return { time, open: price, close: price, high: price, low: price, volume, amount, avg_price: cumulativeVolume ? cumulativeAmount / cumulativeVolume / 100 : price };
        }).filter((row) => row.close !== null);
        const quote = result.qt && result.qt[symbol];
        return { code, name: quote && quote[1], type, source: "腾讯证券分时行情", pre_close: quote ? number(quote[4]) : null, rows };
      }
      const period = { daily: "day", weekly: "week", monthly: "month" }[type];
      const limit = { daily: 240, weekly: 180, monthly: 120 };
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,,${limit[type]},qfq`;
      const response = await nativeFetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`腾讯K线返回 ${response.status}`);
      const payload = await response.json();
      const data = payload && payload.data && payload.data[symbol];
      const rawRows = data && (data[`qfq${period}`] || data[period]);
      if (!Array.isArray(rawRows)) throw new Error("腾讯K线行情为空");
      let previous = null;
      const rows = rawRows.map((fields) => {
        const close = number(fields[2]);
        const high = number(fields[3]);
        const low = number(fields[4]);
        const change = previous === null || close === null ? null : close - previous;
        const row = {
          date: String(fields[0] || ""),
          open: number(fields[1]),
          close,
          high,
          low,
          volume: number(fields[5]),
          amount: null,
          amplitude: low ? (high - low) / low * 100 : null,
          pct: previous ? change / previous * 100 : null,
          change,
          turnover: null,
        };
        previous = close;
        return row;
      }).filter((row) => row.close !== null);
      return { code, name: null, type, source: "腾讯证券前复权K线", rows };
    });
  }

  function normalizedBar(item, previous) {
    const values = Array.isArray(item) ? item : [item.d, item.o, item.h, item.l, item.c, item.v, item.p, item.s];
    const open = number(values[1]);
    const high = number(values[2]);
    const low = number(values[3]);
    const close = number(values[4]);
    if ([open, high, low, close].some((value) => value === null)) return null;
    const change = previous === null ? null : close - previous;
    return { date: String(values[0] || ""), open, close, high, low, volume: number(values[5]) || 0, amount: null, amplitude: low ? (high - low) / low * 100 : null, pct: previous ? change / previous * 100 : null, change, turnover: null, hold: number(values[6]), settle: number(values[7]) };
  }

  function aggregateBars(rows, frequency) {
    const groups = new Map();
    for (const row of rows) {
      const date = String(row.date).slice(0, 10);
      let key = date.slice(0, 7);
      if (frequency === "weekly") {
        const day = new Date(`${date}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
        key = day.toISOString().slice(0, 10);
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    let previous = null;
    const result = [];
    for (const [date, group] of groups) {
      const close = group[group.length - 1].close;
      const high = Math.max(...group.map((row) => row.high));
      const low = Math.min(...group.map((row) => row.low));
      const change = previous === null ? null : close - previous;
      result.push({ date, open: group[0].open, close, high, low, volume: group.reduce((sum, row) => sum + (row.volume || 0), 0), amount: null, amplitude: low ? (high - low) / low * 100 : null, pct: previous ? change / previous * 100 : null, change, turnover: null, hold: group[group.length - 1].hold, settle: group[group.length - 1].settle });
      previous = close;
    }
    return result;
  }

  async function lithiumChart(requested) {
    const periods = { minute1: "1", minute5: "5", minute15: "15", minute30: "30", minute60: "60" };
    const type = ["daily", "weekly", "monthly", ...Object.keys(periods)].includes(requested) ? requested : "daily";
    return cached(`lc-chart:${type}`, periods[type] ? 5000 : 60000, async () => {
      const variable = `__lc${Date.now()}${Math.random().toString(16).slice(2)}`;
      let source = "新浪期货行情";
      let raw;
      if (periods[type]) {
        raw = await scriptVariable(`https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20${variable}=/InnerFuturesNewService.getFewMinLine?symbol=LC0&type=${periods[type]}`, variable);
        source = `新浪期货${periods[type]}分钟行情`;
      } else {
        raw = await scriptVariable(`https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20${variable}=/InnerFuturesNewService.getDailyKLine?symbol=LC0&type=2021_04_12`, variable);
      }
      let previous = null;
      let rows = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        const bar = normalizedBar(item, previous);
        if (!bar) continue;
        rows.push(bar);
        previous = bar.close;
      }
      if (type === "weekly" || type === "monthly") rows = aggregateBars(rows, type);
      const limit = periods[type] ? 1023 : ({ daily: 480, weekly: 180, monthly: 80 })[type];
      const visible = periods[type] ? 120 : ({ daily: 120, weekly: 104, monthly: 48 })[type];
      return {
        code: "LC0",
        name: "碳酸锂连续",
        type,
        source,
        rows: rows.slice(-limit),
        default_visible: visible,
        reference_lines: [{ value: 150000, label: "风险线 15万", level: "risk" }, { value: 155000, label: "观察线 15.5万", level: "watch" }, { value: 160000, label: "企稳线 16万", level: "stable" }],
        contract_note: "主力连续合约换月时可能跳变，不等同于碳酸锂现货价格。",
      };
    });
  }

  async function handleApi(path, init) {
    const url = new URL(path, location.origin);
    const method = String(init && init.method || "GET").toUpperCase();
    if (method === "GET" && url.pathname === "/api/snapshot") return jsonResponse(await buildSnapshot());
    if (method === "GET" && url.pathname === "/api/config") return jsonResponse(await loadStored(CONFIG_KEY, "config"));
    if (method === "GET" && url.pathname === "/api/journal") return jsonResponse(await loadStored(JOURNAL_KEY, "journal"));
    if (method === "GET" && url.pathname === "/api/lithium") return jsonResponse(await fetchLithium());
    if (method === "GET" && url.pathname === "/api/chart") return jsonResponse(await stockChart(url.searchParams.get("code"), url.searchParams.get("type")));
    if (method === "GET" && url.pathname === "/api/lithium-chart") return jsonResponse(await lithiumChart(url.searchParams.get("type")));
    if (method === "GET" && url.pathname === "/api/financials") {
      const code = url.searchParams.get("code");
      return jsonResponse({ code, source: "东方财富F10", finance_url: `https://emweb.securities.eastmoney.com/PC_HSF10/FinanceAnalysis/Index?type=web&code=${emCode(code)}`, quarterly: [], annual: [], quarterly_error: "公开移动版请点击打开东方财富F10查看。", annual_error: "公开移动版请点击打开东方财富F10查看。" });
    }
    if (method === "POST" && url.pathname === "/api/config") {
      const value = JSON.parse(init.body || "{}");
      if (!Array.isArray(value.stocks)) return jsonResponse({ error: "配置格式错误" }, 400);
      localStorage.setItem(CONFIG_KEY, JSON.stringify(value));
      cache.delete("quotes");
      return jsonResponse({ ok: true });
    }
    if (method === "POST" && url.pathname === "/api/journal") {
      const value = JSON.parse(init.body || "{}");
      if (!Array.isArray(value.trades)) return jsonResponse({ error: "日志格式错误" }, 400);
      value.updated_at = nowText();
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(value));
      return jsonResponse({ ok: true, updated_at: value.updated_at });
    }
    return jsonResponse({ error: "接口不存在" }, 404);
  }

  window.fetch = function (input, init) {
    const target = typeof input === "string" ? input : input && input.url;
    if (target && (target.startsWith("/api/") || target.startsWith(`${location.origin}/api/`))) {
      return handleApi(target, init || {}).catch((error) => jsonResponse({ error: error.message || "公开行情请求失败" }, 502));
    }
    return nativeFetch(input, init);
  };
})();
