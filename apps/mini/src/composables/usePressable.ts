import { ref } from 'vue';

/**
 * 通用按压反馈。
 * 用 touch 事件而不是 CSS :active —— 微信小程序里 :active 在部分机型不触发，
 * 且设计要求「80ms scale(.985)，不做位移」。按下状态由组件自己管，才能保证四端一致。
 */
export function usePressable(isDisabled: () => boolean = () => false) {
  const pressed = ref(false);

  const onTouchstart = () => {
    if (isDisabled()) return;
    pressed.value = true;
  };
  const release = () => {
    pressed.value = false;
  };

  return { pressed, onTouchstart, onTouchend: release, onTouchcancel: release };
}
