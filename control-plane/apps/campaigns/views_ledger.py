"""测试数据台账页（2026-10-21 ian：真实交易单据留痕，按单号秒查归属——安全铁律配套）。"""
from datetime import datetime, time as dtime
from django.contrib.auth.decorators import login_required
from django.core.paginator import Paginator
from django.db.models import Q
from django.shortcuts import render
from .models import TradeRecord

PAGE_SIZE = 20


@login_required
def ledger_list(request):
    qs = TradeRecord.objects.all()
    q = (request.GET.get('q') or '').strip()
    f_kind = request.GET.get('kind') or ''
    f_site = (request.GET.get('site') or '').strip()
    date_from = (request.GET.get('date_from') or '').strip()
    date_to = (request.GET.get('date_to') or '').strip()
    if q:
        qs = qs.filter(Q(sn__icontains=q) | Q(account__icontains=q))
    if f_kind in ('order', 'express', 'package'):
        qs = qs.filter(kind=f_kind)
    if f_site:
        qs = qs.filter(site_code__iexact=f_site)
    try:
        if date_from:
            qs = qs.filter(created_at__gte=datetime.strptime(date_from, '%Y-%m-%d'))
        if date_to:
            qs = qs.filter(created_at__lte=datetime.combine(datetime.strptime(date_to, '%Y-%m-%d'), dtime.max))
    except ValueError:
        pass  # 非法日期静默跳过
    total = qs.count()
    counts = {k: TradeRecord.objects.filter(kind=k).count() for k in ('order', 'express', 'package')}
    paginator = Paginator(qs.order_by('-created_at'), PAGE_SIZE)
    page = paginator.get_page(request.GET.get('page'))
    params = {k: v for k, v in (('q', q), ('kind', f_kind), ('site', f_site),
                                ('date_from', date_from), ('date_to', date_to)) if v}
    return render(request, 'campaigns/ledger.html', {
        'page_obj': page, 'total': total, 'counts': counts,
        'q': q, 'f_kind': f_kind, 'f_site': f_site, 'date_from': date_from, 'date_to': date_to,
        'params': params,
    })
