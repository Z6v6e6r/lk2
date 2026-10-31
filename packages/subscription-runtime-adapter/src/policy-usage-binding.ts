// Compatibility export: both the adapter and persistence boundary use one strict parser.
export {
  CommercialBindingRefError,
  parseCommercialPolicyRef,
  parseCommercialUsageRef,
  parseCommercialBindingRefs,
  commercialPolicyRefsEqual,
  commercialUsageRefsEqual,
  commercialBindingRefsEqual,
  type CommercialBindingRefErrorCode,
  type CommercialPolicyRef,
  type CommercialUsageRef,
  type CommercialBindingRefs,
} from '@phub/domain';
