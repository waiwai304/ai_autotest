from django import template

register = template.Library()


@register.filter
def get_item(d, key):
    """字典/映射按变量 key 取值（模板点语法不支持变量键名）"""
    if isinstance(d, dict):
        return d.get(key)
    return getattr(d, str(key), None)
