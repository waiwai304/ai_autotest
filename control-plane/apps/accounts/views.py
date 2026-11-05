from django.contrib.auth import views as auth_views
from django.shortcuts import redirect

class LoginView(auth_views.LoginView):
    template_name = 'registration/login.html'

    def dispatch(self, request, *args, **kwargs):
        # 已登录用户访问 /login/ 直接进工作台（避免渲染空壳页）
        if request.user.is_authenticated:
            return redirect('dashboard')
        return super().dispatch(request, *args, **kwargs)

def home(request):
    return redirect('/dashboard/' if request.user.is_authenticated else '/login/')
