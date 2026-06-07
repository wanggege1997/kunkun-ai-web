import { prisma } from '@/lib/prisma';
import { cacheKeys, invalidateCache } from '@/lib/redis-cache';
import {
  closeWechatOrder,
  createWechatNativeOrder,
  createWechatRefund,
  queryWechatOrderByOutTradeNo,
} from '@/lib/wechat-pay';

type CreditPaymentInput = {
  orderNo: string;
  thirdTradeNo?: string | null;
  paidAmountFen: number;
  paidAt?: Date;
  rawNotify?: unknown;
};

type RefundPaymentInput = {
  orderNo: string;
  reason?: string;
  operatorId?: string;
};

type WechatSyncResult = {
  synced: boolean;
  order: {
    orderNo: string;
    channel: string;
    amountFen: number;
    points: number;
    status: string;
    codeUrl: string | null;
    timeExpireAt: Date | null;
    thirdTradeNo: string | null;
    paidAt: Date | null;
    refundStatus: string | null;
    refundedAt: Date | null;
    updatedAt: Date;
  } | null;
};

function getPaymentRowSelect() {
  return {
    id: true,
    orderNo: true,
    userId: true,
    channel: true,
    amountFen: true,
    points: true,
    status: true,
    codeUrl: true,
    timeExpireAt: true,
    gatewayStatus: true,
    gatewayCheckedAt: true,
    thirdTradeNo: true,
    paidAmountFen: true,
    paidAt: true,
    refundNo: true,
    refundId: true,
    refundAmountFen: true,
    refundReason: true,
    refundStatus: true,
    refundedAt: true,
    closedAt: true,
    updatedAt: true,
  } as const;
}

function isRefundSuccessStatus(status: string | null | undefined) {
  return String(status || '').toUpperCase() === 'SUCCESS';
}

function getRemoteAmountTotal(remote: Record<string, unknown>) {
  const amount = remote.amount as { total?: unknown } | undefined;
  return Number(amount?.total || 0);
}

export async function createWechatNativePaymentOrder(input: {
  orderNo: string;
  amountFen: number;
  description: string;
  timeExpireAt: Date;
}) {
  const wechatOrder = await createWechatNativeOrder({
    orderNo: input.orderNo,
    amountFen: input.amountFen,
    description: input.description,
    timeExpireAt: input.timeExpireAt,
  });

  await prisma.paymentOrder.update({
    where: { orderNo: input.orderNo },
    data: {
      status: 'pending',
      codeUrl: wechatOrder.codeUrl,
      timeExpireAt: input.timeExpireAt,
      gatewayStatus: 'NOTPAY',
      gatewayCheckedAt: null,
      closedAt: null,
      refundStatus: null,
      refundedAt: null,
    },
  });

  return wechatOrder.codeUrl;
}

export async function creditPaymentOrder(input: CreditPaymentInput) {
  const paidAt = input.paidAt instanceof Date && !Number.isNaN(input.paidAt.getTime()) ? input.paidAt : new Date();
  const amountFen = Math.floor(Number(input.paidAmountFen || 0));
  if (!Number.isInteger(amountFen) || amountFen <= 0) {
    throw new Error('支付金额不合法');
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({
      where: { orderNo: input.orderNo },
      select: getPaymentRowSelect(),
    });

    if (!order) {
      throw new Error('订单不存在');
    }

    if (order.amountFen !== amountFen) {
      throw new Error('金额校验失败');
    }

    if (order.status === 'credited') {
      return { credited: true, order };
    }

    if (['closed', 'refund_pending', 'refunded'].includes(order.status)) {
      throw new Error(`订单状态不允许入账: ${order.status}`);
    }

    const updated = await tx.paymentOrder.updateMany({
      where: {
        id: order.id,
        status: { in: ['pending', 'paid'] },
      },
      data: {
        status: 'credited',
        thirdTradeNo: input.thirdTradeNo || order.thirdTradeNo,
        paidAmountFen: amountFen,
        paidAt,
        gatewayStatus: 'SUCCESS',
        gatewayCheckedAt: new Date(),
        refundStatus: null,
      },
    });

    if (updated.count === 0) {
      const current = await tx.paymentOrder.findUnique({
        where: { orderNo: input.orderNo },
        select: getPaymentRowSelect(),
      });
      return { credited: false, order: current };
    }

    const balance = await tx.user.findUnique({
      where: { id: order.userId },
      select: { points: true },
    });

    if (!balance) {
      throw new Error('用户不存在');
    }

    const nextPoints = balance.points + order.points;
    const updatedUser = await tx.user.update({
      where: { id: order.userId },
      data: { points: nextPoints },
      select: { id: true, points: true },
    });

    await tx.pointLog.create({
      data: {
        userId: order.userId,
        delta: order.points,
        reason: `${order.channel}充值到账 订单:${order.orderNo}`,
        relatedId: order.orderNo,
        balanceAfter: updatedUser.points,
      },
    });

    return {
      credited: true,
      order: await tx.paymentOrder.findUnique({
        where: { orderNo: input.orderNo },
        select: getPaymentRowSelect(),
      }),
    };
  });

  if (result.order) {
    await invalidateCache(cacheKeys.user(result.order.userId), cacheKeys.pointLedger(result.order.userId));
  }

  return result;
}

export async function syncWechatOrderStatus(orderNo: string): Promise<WechatSyncResult> {
  const order = await prisma.paymentOrder.findUnique({
    where: { orderNo },
    select: getPaymentRowSelect(),
  });

  if (!order) {
    return { synced: false, order: null };
  }

  if (order.channel !== 'wechat') {
    return { synced: false, order };
  }

  if (['credited', 'closed', 'refund_pending', 'refunded'].includes(order.status)) {
    return { synced: false, order };
  }

  if (order.gatewayCheckedAt && Date.now() - order.gatewayCheckedAt.getTime() < 8_000) {
    return { synced: false, order };
  }

  const remote = await queryWechatOrderByOutTradeNo(order.orderNo);
  const tradeState = String(remote?.trade_state || '').toUpperCase();
  const transactionId = String(remote?.transaction_id || '').trim() || null;
  const total = getRemoteAmountTotal(remote);
  const payer = remote.payer as { finish_time?: unknown } | undefined;
  const successTime = String(remote?.success_time || payer?.finish_time || '').trim();
  const paidAt = successTime ? new Date(successTime) : new Date();
  const safePaidAt = Number.isNaN(paidAt.getTime()) ? new Date() : paidAt;

  if (tradeState === 'SUCCESS') {
    await creditPaymentOrder({
      orderNo: order.orderNo,
      thirdTradeNo: transactionId,
      paidAmountFen: Number.isInteger(total) && total > 0 ? total : order.amountFen,
      paidAt: safePaidAt,
      rawNotify: remote,
    });
    const latest = await prisma.paymentOrder.findUnique({
      where: { orderNo: order.orderNo },
      select: getPaymentRowSelect(),
    });
    return { synced: true, order: latest };
  }

  if (tradeState === 'CLOSED') {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'pending' },
      data: {
        status: 'closed',
        gatewayStatus: tradeState,
        gatewayCheckedAt: new Date(),
        closedAt: new Date(),
      },
    });
  } else {
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: {
        gatewayStatus: tradeState || null,
        gatewayCheckedAt: new Date(),
      },
    });
  }

  return {
    synced: tradeState === 'CLOSED',
    order: await prisma.paymentOrder.findUnique({
      where: { orderNo: order.orderNo },
      select: getPaymentRowSelect(),
    }),
  };
}

export async function closePaymentOrder(orderNo: string) {
  const order = await prisma.paymentOrder.findUnique({
    where: { orderNo },
    select: getPaymentRowSelect(),
  });

  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.status === 'closed') {
    return { closed: true, order };
  }

  if (['credited', 'paid', 'refund_pending', 'refunded'].includes(order.status)) {
    throw new Error(`订单状态不允许关闭: ${order.status}`);
  }

  if (order.channel === 'wechat') {
    const refreshed = await syncWechatOrderStatus(order.orderNo).catch(() => null);
    if (refreshed?.order?.status === 'credited') {
      return { closed: false, order: refreshed.order };
    }
    await closeWechatOrder(order.orderNo);
  }

  const updated = await prisma.paymentOrder.updateMany({
    where: { id: order.id, status: 'pending' },
    data: {
      status: 'closed',
      gatewayStatus: 'CLOSED',
      gatewayCheckedAt: new Date(),
      closedAt: new Date(),
    },
  });

  const latest = await prisma.paymentOrder.findUnique({
    where: { orderNo },
    select: getPaymentRowSelect(),
  });

  return {
    closed: updated.count > 0,
    order: latest,
  };
}

export async function requestWechatRefund(input: RefundPaymentInput) {
  const order = await prisma.paymentOrder.findUnique({
    where: { orderNo: input.orderNo },
    select: getPaymentRowSelect(),
  });

  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.channel !== 'wechat') {
    throw new Error('当前仅支持微信订单退款');
  }

  if (order.status === 'refunded') {
    return { refunded: true, order };
  }

  if (order.status !== 'credited') {
    throw new Error(`订单状态不允许退款: ${order.status}`);
  }

  const refundNo = `RF${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const refund = await createWechatRefund({
    orderNo: order.orderNo,
    refundNo,
    amountFen: order.amountFen,
    reason: input.reason || '商户人工退款',
    transactionId: order.thirdTradeNo || undefined,
  });

  await prisma.paymentOrder.update({
    where: { orderNo: order.orderNo },
    data: {
      status: 'refund_pending',
      gatewayStatus: 'REFUND',
      gatewayCheckedAt: new Date(),
      refundNo,
      refundId: String(refund?.refund_id || refund?.refundId || ''),
      refundAmountFen: order.amountFen,
      refundReason: input.reason || '商户人工退款',
      refundStatus: 'PROCESSING',
    },
  });

  return {
    refunded: false,
    order: await prisma.paymentOrder.findUnique({
      where: { orderNo: order.orderNo },
      select: getPaymentRowSelect(),
    }),
  };
}

export async function finalizeWechatRefund(orderNo: string, refundStatus: string, refundId?: string | null, successTime?: Date | null) {
  const order = await prisma.paymentOrder.findUnique({
    where: { orderNo },
    select: getPaymentRowSelect(),
  });

  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.status === 'refunded') {
    return { refunded: true, order };
  }

  const normalizedRefundStatus = String(refundStatus || '').toUpperCase();
  if (normalizedRefundStatus === 'PROCESSING') {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'refund_pending' },
      data: {
        refundStatus: 'PROCESSING',
        refundId: refundId || order.refundId,
      },
    });
    return {
      refunded: false,
      order: await prisma.paymentOrder.findUnique({
        where: { orderNo },
        select: getPaymentRowSelect(),
      }),
    };
  }

  if (!isRefundSuccessStatus(normalizedRefundStatus)) {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'refund_pending' },
      data: {
        refundStatus: normalizedRefundStatus || order.refundStatus,
        refundId: refundId || order.refundId,
      },
    });
    return {
      refunded: false,
      order: await prisma.paymentOrder.findUnique({
        where: { orderNo },
        select: getPaymentRowSelect(),
      }),
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const refreshed = await tx.paymentOrder.findUnique({
      where: { orderNo },
      select: getPaymentRowSelect(),
    });
    if (!refreshed) {
      throw new Error('订单不存在');
    }
    if (refreshed.status === 'refunded') {
      return { refunded: true, order: refreshed };
    }
    if (refreshed.status !== 'refund_pending') {
      throw new Error(`订单状态不允许完成退款: ${refreshed.status}`);
    }

    const updated = await tx.paymentOrder.updateMany({
      where: { id: refreshed.id, status: 'refund_pending' },
      data: {
        status: 'refunded',
        gatewayStatus: 'REFUND',
        gatewayCheckedAt: new Date(),
        refundStatus: String(refundStatus || 'SUCCESS').toUpperCase(),
        refundId: refundId || refreshed.refundId,
        refundedAt: successTime || new Date(),
      },
    });

    if (updated.count === 0) {
      return {
        refunded: true,
        order: await tx.paymentOrder.findUnique({
          where: { orderNo },
          select: getPaymentRowSelect(),
        }),
      };
    }

    const user = await tx.user.findUnique({
      where: { id: refreshed.userId },
      select: { points: true },
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const updatedUser = await tx.user.update({
      where: { id: refreshed.userId },
      data: { points: user.points - refreshed.points },
      select: { points: true },
    });

    await tx.pointLog.create({
      data: {
        userId: refreshed.userId,
        delta: -refreshed.points,
        reason: `微信退款回退 订单:${refreshed.orderNo}`,
        relatedId: refreshed.orderNo,
        balanceAfter: updatedUser.points,
      },
    });

    return {
      refunded: true,
      order: await tx.paymentOrder.findUnique({
        where: { orderNo },
        select: getPaymentRowSelect(),
      }),
    };
  });

  if (result.order) {
    await invalidateCache(cacheKeys.user(result.order.userId), cacheKeys.pointLedger(result.order.userId));
  }

  return result;
}
