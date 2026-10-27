"""Gunicorn settings for PaperQuest.

模型连接信息保存在进程内存里，所以默认只开 1 个 worker、用多线程处理并发，
避免多个 worker 之间配置不一致。若所有配置都写在 .env，可把
GUNICORN_WORKERS 调大。
"""

import os

bind = os.getenv("GUNICORN_BIND", "0.0.0.0:8000")
workers = int(os.getenv("GUNICORN_WORKERS", "1"))
threads = int(os.getenv("GUNICORN_THREADS", "8"))
timeout = int(os.getenv("GUNICORN_TIMEOUT", "300"))
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
loglevel = os.getenv("GUNICORN_LOGLEVEL", "info")
