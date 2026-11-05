from django.db import models

class PolicyPackVersion(models.Model):
    code = models.SlugField(unique=True)
    version = models.PositiveIntegerField(default=1)
    name = models.CharField(max_length=200, blank=True)
    content = models.TextField()
    locked = models.BooleanField(default=False)
    sha256 = models.CharField(max_length=64)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['code', '-version']

    def __str__(self):
        return f'{self.code}@{self.version}'
