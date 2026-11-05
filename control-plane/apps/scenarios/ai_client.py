# -*- coding: utf-8 -*-
"""Agent 接入客户端（2026-10-30 ian：AI 口语建用例一期）。
OpenAI 兼容 /chat/completions 协议（DeepSeek 同款，自定义 base_url）。

要点：
- urllib + ProxyHandler({}) 强制直连，不吃环境代理（服务器 7890 代理上游常坏）
- JSON 容错解析：优先整段 parse；失败用平衡大括号提取第一个 {...} 块
- reasoning 模型兼容：思考 token 计入 max_tokens；content 空且 finish_reason=length
  → 明确报「max_tokens 不足」，不静默返回空
- 错误友好化：401=key 无效 / 404=模型名不存在（提示全小写坑）/ 429=限流
"""
import json
import re
import time
import urllib.error
import urllib.request


class AiClientError(Exception):
    """面向用户的 AI 调用错误（消息可直接展示）"""


def _messages_url(base_url: str) -> str:
    base = (base_url or '').strip().rstrip('/')
    if not re.match(r'^https?://', base):
        raise AiClientError('接口地址必须以 http(s):// 开头')
    return base + '/chat/completions'


def _post_chat(cfg, messages: list, max_tokens: int | None = None) -> dict:
    """POST chat/completions，返回完整响应 dict。网络/协议错误统一抛 AiClientError。"""
    url = _messages_url(cfg.base_url)
    payload = {
        'model': cfg.model.strip(),
        'messages': messages,
        'temperature': float(cfg.temperature),
        'max_tokens': int(max_tokens or cfg.max_tokens),
    }
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {cfg.api_key.strip()}',
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 禁代理直连
    try:
        with opener.open(req, timeout=int(cfg.timeout_sec or 120)) as resp:
            return json.loads(resp.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', 'replace')[:300]
        except Exception:
            pass
        hint = {401: 'API key 无效或未授权', 403: '无权限访问该模型',
                404: f'接口路径或模型不存在（检查 base_url 是否带 /v1、模型名大小写，部分网关要求全小写）',
                429: '触发限流，稍后重试'}.get(e.code, f'HTTP {e.code}')
        raise AiClientError(f'{hint}：{body or e.reason}')
    except urllib.error.URLError as e:
        raise AiClientError(f'连接失败：{e.reason}（检查接口地址/网络/代理）')
    except TimeoutError:
        raise AiClientError(f'请求超时（>{cfg.timeout_sec}s）')
    except json.JSONDecodeError as e:
        raise AiClientError(f'响应不是合法 JSON：{e}')


def _choice_content(resp: dict) -> str:
    """取首个 choice 的 content；识别 reasoning 模型 token 不足形态"""
    try:
        ch = resp['choices'][0]
    except (KeyError, IndexError):
        err = resp.get('error')
        raise AiClientError(f'响应缺少 choices：{json.dumps(err or resp, ensure_ascii=False)[:200]}')
    msg = ch.get('message') or {}
    content = (msg.get('content') or '').strip()
    if not content and ch.get('finish_reason') == 'length':
        raise AiClientError('max_tokens 不足（reasoning 思考已耗尽额度），请调大「最大 tokens」后重试')
    return content


_BALANCED_RE = re.compile(r'\{[^{}]*\}')


def extract_json(text: str):
    """从回复文本提取 JSON：整段 parse → 平衡大括号扫描 → 失败返回 None"""
    text = (text or '').strip()
    # 剥 markdown 代码围栏
    text = re.sub(r'^```(?:json)?\s*', '', text).rstrip('`').strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    # 平衡大括号扫描（跳过字符串字面量内的括号）
    depth, start, in_str, esc = 0, -1, False, False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except (json.JSONDecodeError, ValueError):
                        start = -1
    return None


def chat_stream(cfg, system: str, user: str, max_tokens: int | None = None):
    """流式对话（2026-11-04 ian：AI 建用例页面实时输出）。
    生成器逐个 yield 事件 dict：
      {'type': 'delta', 'text': '增量正文'}         —— 模型输出的 content 增量
      {'type': 'reasoning', 'text': '思考增量'}      —— reasoning 模型的思考增量（可无）
      {'type': 'usage', 'usage': {...}}              —— 最后一个 chunk 附带的用量（可无）
    网络/协议错误统一抛 AiClientError（在迭代时抛出）。"""
    url = _messages_url(cfg.base_url)
    payload = {
        'model': cfg.model.strip(),
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        'temperature': float(cfg.temperature),
        'max_tokens': int(max_tokens or cfg.max_tokens),
        'stream': True,
    }
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {cfg.api_key.strip()}',
        'Accept': 'text/event-stream',
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 禁代理直连
    try:
        resp = opener.open(req, timeout=int(cfg.timeout_sec or 120))
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', 'replace')[:300]
        except Exception:
            pass
        hint = {401: 'API key 无效或未授权', 403: '无权限访问该模型',
                404: f'接口路径或模型不存在（检查 base_url 是否带 /v1、模型名大小写，部分网关要求全小写）',
                429: '触发限流，稍后重试'}.get(e.code, f'HTTP {e.code}')
        raise AiClientError(f'{hint}：{body or e.reason}')
    except urllib.error.URLError as e:
        raise AiClientError(f'连接失败：{e.reason}（检查接口地址/网络/代理）')
    except TimeoutError:
        raise AiClientError(f'连接超时（>{cfg.timeout_sec}s）')

    with resp:
        for raw in resp:   # urllib 逐行迭代 = 天然流式（SSE 按 \n 分帧）
            try:
                line = raw.decode('utf-8', 'replace').strip()
            except Exception:
                continue
            if not line or not line.startswith('data:'):
                continue
            piece = line[5:].strip()
            if piece == '[DONE]':
                break
            try:
                obj = json.loads(piece)
            except (json.JSONDecodeError, ValueError):
                continue   # 网关心跳/注释行
            if not isinstance(obj, dict):
                continue
            usage = obj.get('usage')
            if isinstance(usage, dict) and usage:
                yield {'type': 'usage', 'usage': usage}
            err = obj.get('error')
            if err:
                raise AiClientError(f'网关返回错误：{json.dumps(err, ensure_ascii=False)[:200]}')
            try:
                delta = (obj['choices'][0] or {}).get('delta') or {}
            except (KeyError, IndexError, TypeError):
                continue
            reasoning = delta.get('reasoning_content') or ''
            if reasoning:
                yield {'type': 'reasoning', 'text': reasoning}
            text = delta.get('content') or ''
            if text:
                yield {'type': 'delta', 'text': text}


def chat_text(cfg, system: str, user: str) -> str:
    """单轮对话，返回 content 文本"""
    resp = _post_chat(cfg, [{'role': 'system', 'content': system},
                            {'role': 'user', 'content': user}])
    return _choice_content(resp)


def chat_json(cfg, system: str, user: str):
    """单轮对话并解析 JSON。返回 (data, None) 或 (None, 错误消息)。"""
    data, err, _ = chat_json_ex(cfg, system, user)
    return data, err


def chat_json_ex(cfg, system: str, user: str, max_tokens: int | None = None):
    """chat_json 增强版（2026-11-02 ian：AI 调用耗时/token 提醒）。
    返回 (data, err, stats)——stats = {elapsed_ms, prompt_tokens, completion_tokens, total_tokens}。
    tokens 取网关 usage（缺失时为 None，由展示端回退为估算文案）。"""
    t0 = time.monotonic()
    try:
        resp = _post_chat(cfg, [{'role': 'system', 'content': system},
                                {'role': 'user', 'content': user}], max_tokens=max_tokens)
    except AiClientError as e:
        return None, str(e), {'elapsed_ms': int((time.monotonic() - t0) * 1000)}
    content = _choice_content(resp)
    usage = (resp or {}).get('usage') or {}
    stats = {
        'elapsed_ms': int((time.monotonic() - t0) * 1000),
        'prompt_tokens': usage.get('prompt_tokens'),
        'completion_tokens': usage.get('completion_tokens'),
        'total_tokens': usage.get('total_tokens'),
    }
    data = extract_json(content)
    if data is None:
        return None, '模型未返回可解析的 JSON（已尝试容错提取），请重试或调整描述', stats
    return data, None, stats


def test_connection(cfg) -> tuple[bool, str]:
    """配置页「测试连接」：最小请求。返回 (ok, 面向用户的消息)。"""
    try:
        t0 = time.monotonic()
        content = chat_text(cfg, '你是连通性探针。', '只回复两个字：连通')
        ms = int((time.monotonic() - t0) * 1000)
        return True, f'连通正常（{ms}ms）：{(content or "").strip()[:50] or "(空响应)"}'
    except AiClientError as e:
        return False, str(e)
