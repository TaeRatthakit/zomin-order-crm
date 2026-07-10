# Zomin Order CRM V3

เว็บแอพ CRM สำหรับจัดการออเดอร์ Zomin ตาม Workflow V3 Phase 1

## วิธีรัน

```bash
npm run build
npm start
```

เปิดเว็บที่:

```text
http://localhost:3000
```

Routes หลัก:

```text
/login
/dashboard
/customers
/orders
/follow-up
/more
```

## บัญชีเริ่มต้น

```text
Owner: admin / admin123
Staff: staff / staff123
```

## สิ่งที่ทำไว้ใน Phase 1

- Dashboard สรุปยอดขาย ลูกค้า VIP ลูกค้าเสี่ยงหาย และคิวโทรวันนี้
- หน้าออเดอร์ทั้งหมด พร้อมเพิ่มออเดอร์ด้วยมือ
- ค้นหาลูกค้าจากชื่อ เบอร์ Tag สถานะ และ VIP Level
- หน้าลูกค้าที่ควรทักวันนี้ พร้อมปุ่มโทร คัดลอกเบอร์ และคัดลอกข้อความ
- หน้า VIP, ลูกค้าเสี่ยงหาย, Import ข้อมูลเก่า, รายงานยอดขาย, ทีมงาน และ Settings
- คำนวณสถานะ NEW, NORMAL, VIP, VVIP, SUPER VIP, AT RISK, LOST อัตโนมัติ
- คำนวณ Follow-up จากจำนวนกระปุกล่าสุด และแก้กฎได้ใน Settings
- เก็บ Tag ได้ไม่จำกัด
- เตรียม endpoint `POST /api/line/webhook`
- เตรียมช่องตั้งค่า LINE Channel ID, Channel Secret และ Channel Access Token

## การเก็บข้อมูล

ค่าเริ่มต้นเป็น JSON mode สำหรับรันในเครื่อง:

```text
data/db.json
```

สำหรับ production ให้ใช้ Supabase:

```bash
DATABASE_PROVIDER=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SESSION_SECRET=...
```

อ่านขั้นตอนเต็มใน `README_DEPLOY.md`

## Production Preparation

- มี signed cookie auth แบบ httpOnly และ role guard สำหรับ Owner / Admin / Staff
- รหัสผ่านใน `data/db.json` เก็บเป็น `passwordHash`
- มี Supabase schema ที่ `supabase/schema.sql`
- มี seed script `npm run seed`
- มี migration script `npm run migrate:supabase`
- มี export CSV และ JSON backup สำหรับ Owner/Admin
- มี mock webhook test ในหน้า Settings

## Import ข้อมูลเก่า

รองรับการวางข้อความ LINE เก่าเพื่อ preview ก่อนบันทึก และฟอร์มกรอกเองสำหรับข้อมูลที่ parser อ่านไม่ได้

ตัวอย่างข้อความ LINE:

```text
คุณวิภา
โทร 0891234567
ที่อยู่ 55/1 เชียงใหม่
4 กระปุก แถม 2 กระปุก รวม 4500 บาท
#ปวดข้อ #ซื้อให้พ่อ
```

ตัวอย่าง parser ที่รองรับ:

```text
โทร.083-229-5956
06-4959-5657
4 กระปุก แถม 2 กระปุก
7 แถม 13
รับโซมินฟรี 2 กระปุก
เก็บเงินปลายทาง 500 บาท
ของฟรี
```

## LINE Webhook

Phase 1 ยังไม่เชื่อม LINE จริง แต่ endpoint พร้อมรับข้อมูล:

```text
POST /api/line/webhook
```

ถ้าใส่ `LINE Channel Secret` ใน Settings ระบบจะ verify `x-line-signature` ก่อนรับ webhook ถ้ายังไม่ใส่จะทำงานเป็น mock mode สำหรับทดสอบในเครื่อง

ตัวอย่าง payload:

```json
{
  "events": [
    {
      "message": {
        "text": "คุณวิภา\nโทร 0891234567\nZomin 3 กระปุก รวม 2250 บาท\n#ปวดข้อ"
      }
    }
  ]
}
```
