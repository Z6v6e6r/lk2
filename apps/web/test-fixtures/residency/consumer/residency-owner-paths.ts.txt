/** Owner paths of the LK1 residency lifecycle contract (residency-lifecycle.v2). */
export const RESIDENCY_OWNER_PATHS = Object.freeze({
  catalog: '/lk/residency/catalog',
  orders: '/lk/residency/orders',
  order: (orderId: string) => '/lk/residency/orders/' + orderId,
  payment: (orderId: string) => '/lk/residency/orders/' + orderId + '/payment',
  reconcile: (orderId: string) => '/lk/residency/orders/' + orderId + '/reconcile',
  cancel: (orderId: string) => '/lk/residency/orders/' + orderId + '/cancel',
});
