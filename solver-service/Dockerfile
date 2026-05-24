FROM python:3.12-slim

# OR-Tools native deps. Keep this minimal — full build-essential balloons
# the image; the wheels we install only need libstdc++.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY rr_solver ./rr_solver

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

EXPOSE 8080

# Single uvicorn worker. CP-SAT itself parallelizes internally; running
# multiple uvicorn workers just multiplies memory without speeding up
# any individual solve.
CMD ["uvicorn", "rr_solver.main:app", "--host", "0.0.0.0", "--port", "8080"]
