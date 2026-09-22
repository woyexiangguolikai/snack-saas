/**
 * 「联系店家」的唯一实现。
 *
 * 为什么值得单独一个文件：
 *   空态里最没用的一句话就是"请联系店家" —— 它把问题从系统推给了用户，
 *   而用户并不知道怎么联系。所以凡是要说"联系店家"的地方，
 *   都必须**同时给一个能点的东西**。把它收在一处，
 *   就保证了"要么给得出电话，要么给出一个诚实的替代动作"，
 *   不会出现某个页面忘了接、只剩一句空话。
 *
 * 三种情况，三种诚实的处理：
 *   ① 店家填了客服电话 → 直接拨号（`uni.makePhoneCall`）；
 *   ② 没填 → 把店名复制出去，并说明"这家店还没留客服电话"。
 *      **不能**假装拨号失败，也不能编一个号码；
 *   ③ 用户取消拨号 → 什么都不做。取消是用户的决定，不是错误。
 */
import { useSessionStore } from '../stores/session';

export function callShop(): void {
  const session = useSessionStore();
  const phone = (session.contactPhone || '').trim();

  if (!phone) {
    const name = session.shopName || '这家店';
    // 复制店名是个"至少能带走点什么"的动作：学生可以拿去微信里搜、问同学
    uni.showModal({
      title: `还没有${name}的联系方式`,
      content: '店家还没有在小程序里留下客服电话。你可以先换一栋楼看看，或者过一会再来。',
      confirmText: '复制店名',
      cancelText: '知道了',
      success: (res) => {
        if (!res.confirm) return;
        uni.setClipboardData({
          data: name,
          success: () => uni.showToast({ title: '店名已复制', icon: 'none' }),
        });
      },
    });
    return;
  }

  uni.makePhoneCall({
    phoneNumber: phone,
    // 取消拨号不是失败，不弹任何提示（`fail` 在用户取消时也会触发）
    fail: () => undefined,
  });
}
