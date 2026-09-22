import { ref } from 'vue';

/**
 * 全局撤销条（单例）。
 *
 * 存在的理由是一条产品纪律（AC-08）：**可逆的操作不弹确认，给撤销**。
 *   弹确认会把高频操作变啰嗦（换楼栋、移出一件商品都会变成两步），
 *   而"做完什么都不给"则让学生只能用"重来一遍"来弥补手滑 ——
 *   换楼栋重来一遍的成本是把商品一件件加回去，很多人会直接放弃这一单。
 *
 * 为什么是 5 秒：
 *   短于 3 秒，正在看商品的手还没反应过来条就没了；
 *   长于 8 秒，它会一直挡在吸底条上方，而那时用户大概率已经认可了新状态。
 *
 * ⚠️ 一次只留一条。新的操作覆盖旧的是**正确**的：两条撤销并排摆着，
 *   用户无法判断"撤销"会撤销哪一个，那比没有撤销更危险。
 */
export interface UndoOffer {
  /** 说清"刚发生了什么"，包含被影响的数量 */
  message: string;
  /** 撤销动作。必须把状态**完整**还原（只回一半比不撤销更让人困惑） */
  run: () => void | Promise<void>;
}

const UNDO_MS = 5_000;

const offer = ref<UndoOffer | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

export function useUndoBar() {
  function dismiss(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    offer.value = null;
  }

  function show(next: UndoOffer): void {
    dismiss();
    offer.value = next;
    timer = setTimeout(() => {
      offer.value = null;
      timer = null;
    }, UNDO_MS);
  }

  /** 撤销：**先把条收掉再执行**。执行可能触发新提示，留着旧条会让人以为没生效 */
  async function undo(): Promise<void> {
    const o = offer.value;
    dismiss();
    if (o) await o.run();
  }

  return { offer, show, dismiss, undo };
}
