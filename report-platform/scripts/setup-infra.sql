-- 基础设施：业务只读库 + 只读账号 + 演示数据
-- 用 root 执行：mysql -uroot -proot -h127.0.0.1 -P3306 < scripts/setup-infra.sql

CREATE DATABASE IF NOT EXISTS biz_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE biz_demo;
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_name VARCHAR(120) NOT NULL,
  region       VARCHAR(40)  NOT NULL,
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  status       VARCHAR(20)  NOT NULL DEFAULT 'PAID',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_region (region),
  KEY idx_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customers (
  id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  name    VARCHAR(120) NOT NULL,
  city    VARCHAR(60),
  level   VARCHAR(20) DEFAULT 'NORMAL',
  KEY idx_city (city)
) ENGINE=InnoDB;

-- 演示数据
INSERT INTO customers (name, city, level) VALUES
  ('张三','上海','VIP'),('李四','北京','NORMAL'),('王五','深圳','VIP'),('赵六','广州','NORMAL'),
  ('钱七','杭州','VIP'),('孙八','成都','NORMAL');

INSERT INTO orders (customer_name, region, amount, status, created_at)
SELECT
  c.name,
  CASE WHEN c.city IN ('上海','杭州') THEN '华东'
       WHEN c.city IN ('北京') THEN '华北'
       WHEN c.city IN ('深圳','广州') THEN '华南'
       ELSE '华西' END,
  ROUND(100 + (RAND()*9900), 2),
  ELT(1+FLOOR(RAND()*3), 'PAID','REFUNDED','PENDING'),
  DATE_SUB(NOW(), INTERVAL FLOOR(RAND()*120) DAY)
FROM customers c, (SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) t;

-- 只读账号（与元库物理隔离、账号不复用，REQ-SEC-05/ADR-09）
-- 仅 GRANT SELECT 于 biz_demo → INSERT/UPDATE/DROP 天然失败（M0 验收：只读连接 INSERT 必失败）
DROP USER IF EXISTS 'report_ro'@'%';
CREATE USER 'report_ro'@'%' IDENTIFIED BY 'ReportRo@2026';
GRANT SELECT ON biz_demo.* TO 'report_ro'@'%';
FLUSH PRIVILEGES;
