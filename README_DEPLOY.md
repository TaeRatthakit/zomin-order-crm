# Growup Pilot Production Deploy

## 1. Backup เวอร์ชันที่รันได้

ทำไว้แล้วใน repo นี้:

- Commit: `7d9a6cd Backup working app before production prep`
- Branch: `backup/pre-production-ready-local-json`

## 2. Local JSON Mode

ใช้สำหรับทดสอบในเครื่องและเป็น fallback:

```bash
cp .env.example .env
npm run seed
npm start
```

เปิด `http://127.0.0.1:3000`

Demo login:

- Admin: `admin / admin123`
- Staff: `staff / staff123`

## 3. Supabase Setup

1. สร้าง Supabase project
2. เปิด SQL Editor
3. Run ไฟล์ `supabase/schema.sql`
4. ตั้ง environment:

```bash
DATABASE_PROVIDER=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SESSION_SECRET=long-random-secret
NODE_ENV=production
```

5. ย้ายข้อมูล JSON เดิมเข้า Supabase:

```bash
npm run migrate:supabase
```

## 4. Deploy

### Render

ใช้ `render.yaml` แล้วตั้งค่า environment variables ตามข้อ 3

### Vercel

ใช้ `vercel.json` แล้วตั้งค่า environment variables ตามข้อ 3

หมายเหตุ: แอพนี้ใช้ backend เป็นตัวคุย Supabase ด้วย `SUPABASE_SERVICE_ROLE_KEY` เท่านั้น ห้ามส่ง key นี้ไปฝั่ง browser

## 5. LINE OA

ในหน้า Settings ใส่:

- LINE Channel ID
- LINE Channel Secret
- LINE Channel Access Token

Webhook URL:

```text
https://your-domain.com/api/line/webhook
```

Phase 1 ยังไม่ push/reply กลับ LINE แต่ endpoint รับ webhook, verify signature และบันทึกออเดอร์จากข้อความได้แล้ว

## 6. Verification

```bash
npm run build
```

ควรผ่าน syntax check, ตรวจไฟล์ production และตรวจว่า `data/db.json` ไม่เก็บรหัสผ่านแบบ plain text
