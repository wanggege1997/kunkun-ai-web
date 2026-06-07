import { NextResponse } from 'next/server';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { requestWechatRefund } from '@/lib/payment-service';

export async function POST(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const orderNo = String(body.orderNo || '').trim();
  const reason = String(body.reason || '').trim() || '商户人工退款';

  if (!orderNo) {
    return NextResponse.json({ success: false, message: '缺少订单号' }, { status: 400 });
  }

  try {
    const result = await requestWechatRefund({
      orderNo,
      reason,
      operatorId: sessionUser.id,
    });

    return NextResponse.json({
      success: true,
      data: {
        orderNo,
        status: result.order?.status || 'refund_pending',
        refundNo: result.order?.refundNo || null,
        refundStatus: result.order?.refundStatus || 'PROCESSING',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '退款请求失败';
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}

