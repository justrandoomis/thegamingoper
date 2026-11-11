/**
 * Relations for Drizzle's relational queries — load an aggregate in ONE round trip to D1:
 *
 *   const order = await db.query.orders.findFirst({
 *     where: eq(orders.ref, ref),
 *     with: { items: { with: { variant: true } }, payments: { with: { proofs: true } }, events: true },
 *   });
 *
 * Only the common aggregates are declared; joins with the query builder work for everything else.
 * Relations do not create constraints — the foreign keys live in the table definitions.
 *
 * `variants.protectedCost` exposes [P] cost data: load it only after can(actor, "cost.read").
 * Polymorphic links (media, files, consents, audit events: owner_type + owner_id) cannot be
 * expressed as relations; query them with `where`.
 */
import { relations } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "./accounting";
import { repairEvents, repairTickets, returnItems, returns, warranties } from "./aftersales";
import { categories, deviceGenerations, deviceModels, platforms, products, reviews, variantCosts, variants } from "./catalog";
import { cartItems, carts, coupons, orderEvents, orderItemSerials, orderItems, orders, paymentProofs, payments, refundItems, refunds } from "./commerce";
import { files } from "./core";
import { addresses, customers, guestContacts, wishlistItems } from "./customers";
import { inventoryLocations, serials, stockLevels } from "./inventory";
import { cashMovements, posRegisters, posShifts } from "./pos";
import { poItems, purchaseOrders, receiptItems, receipts, suppliers } from "./purchasing";
import { carriers, districts, governorates, shipmentEvents, shipmentItems, shipments } from "./shipping";
import { employeeRoles, employees, rolePermissions, roles } from "./staff";
import { knowledgeArticles, supportTickets, ticketMessages } from "./support";
import { tradeInEvents, tradeIns, usedUnits } from "./used";

// ───────────────────────────────────────────────────────────────── catalog

export const platformsRelations = relations(platforms, ({ many }) => ({
  generations: many(deviceGenerations),
  deviceModels: many(deviceModels),
  products: many(products),
}));

export const deviceGenerationsRelations = relations(deviceGenerations, ({ one, many }) => ({
  platform: one(platforms, { fields: [deviceGenerations.platformId], references: [platforms.id] }),
  deviceModels: many(deviceModels),
}));

export const deviceModelsRelations = relations(deviceModels, ({ one, many }) => ({
  platform: one(platforms, { fields: [deviceModels.platformId], references: [platforms.id] }),
  generation: one(deviceGenerations, { fields: [deviceModels.generationId], references: [deviceGenerations.id] }),
  products: many(products),
  knowledgeArticles: many(knowledgeArticles),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id], relationName: "category_tree" }),
  children: many(categories, { relationName: "category_tree" }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  platform: one(platforms, { fields: [products.platformId], references: [platforms.id] }),
  deviceModel: one(deviceModels, { fields: [products.deviceModelId], references: [deviceModels.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  variants: many(variants),
  reviews: many(reviews),
}));

export const variantsRelations = relations(variants, ({ one, many }) => ({
  product: one(products, { fields: [variants.productId], references: [products.id] }),
  /** [P] — cost.read only. */
  protectedCost: one(variantCosts),
  stockLevels: many(stockLevels),
}));

export const variantCostsRelations = relations(variantCosts, ({ one }) => ({
  variant: one(variants, { fields: [variantCosts.variantId], references: [variants.id] }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  product: one(products, { fields: [reviews.productId], references: [products.id] }),
  customer: one(customers, { fields: [reviews.customerId], references: [customers.id] }),
}));

// ───────────────────────────────────────────────────────────────── inventory

export const inventoryLocationsRelations = relations(inventoryLocations, ({ many }) => ({
  stockLevels: many(stockLevels),
}));

export const stockLevelsRelations = relations(stockLevels, ({ one }) => ({
  variant: one(variants, { fields: [stockLevels.variantId], references: [variants.id] }),
  location: one(inventoryLocations, { fields: [stockLevels.locationId], references: [inventoryLocations.id] }),
}));

export const serialsRelations = relations(serials, ({ one }) => ({
  variant: one(variants, { fields: [serials.variantId], references: [variants.id] }),
  location: one(inventoryLocations, { fields: [serials.locationId], references: [inventoryLocations.id] }),
}));

// ───────────────────────────────────────────────────────────────── customers and geography

export const customersRelations = relations(customers, ({ many }) => ({
  addresses: many(addresses),
  orders: many(orders),
  wishlistItems: many(wishlistItems),
}));

export const addressesRelations = relations(addresses, ({ one }) => ({
  customer: one(customers, { fields: [addresses.customerId], references: [customers.id] }),
  governorate: one(governorates, { fields: [addresses.governorateId], references: [governorates.id] }),
  district: one(districts, { fields: [addresses.districtId], references: [districts.id] }),
}));

export const wishlistItemsRelations = relations(wishlistItems, ({ one }) => ({
  customer: one(customers, { fields: [wishlistItems.customerId], references: [customers.id] }),
  product: one(products, { fields: [wishlistItems.productId], references: [products.id] }),
}));

export const governoratesRelations = relations(governorates, ({ many }) => ({
  districts: many(districts),
}));

export const districtsRelations = relations(districts, ({ one }) => ({
  governorate: one(governorates, { fields: [districts.governorateId], references: [governorates.id] }),
}));

// ───────────────────────────────────────────────────────────────── carts and orders

export const cartsRelations = relations(carts, ({ one, many }) => ({
  customer: one(customers, { fields: [carts.customerId], references: [customers.id] }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
  variant: one(variants, { fields: [cartItems.variantId], references: [variants.id] }),
  usedUnit: one(usedUnits, { fields: [cartItems.usedUnitId], references: [usedUnits.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  guestContact: one(guestContacts, { fields: [orders.guestContactId], references: [guestContacts.id] }),
  governorate: one(governorates, { fields: [orders.governorateId], references: [governorates.id] }),
  district: one(districts, { fields: [orders.districtId], references: [districts.id] }),
  coupon: one(coupons, { fields: [orders.couponId], references: [coupons.id] }),
  items: many(orderItems),
  payments: many(payments),
  refunds: many(refunds),
  events: many(orderEvents),
  shipments: many(shipments),
  returns: many(returns),
}));

export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(variants, { fields: [orderItems.variantId], references: [variants.id] }),
  usedUnit: one(usedUnits, { fields: [orderItems.usedUnitId], references: [usedUnits.id] }),
  serials: many(orderItemSerials),
}));

export const orderItemSerialsRelations = relations(orderItemSerials, ({ one }) => ({
  orderItem: one(orderItems, { fields: [orderItemSerials.orderItemId], references: [orderItems.id] }),
  serial: one(serials, { fields: [orderItemSerials.serialId], references: [serials.id] }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  proofs: many(paymentProofs),
  refunds: many(refunds),
}));

export const paymentProofsRelations = relations(paymentProofs, ({ one }) => ({
  payment: one(payments, { fields: [paymentProofs.paymentId], references: [payments.id] }),
  file: one(files, { fields: [paymentProofs.fileId], references: [files.id] }),
}));

export const refundsRelations = relations(refunds, ({ one, many }) => ({
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  payment: one(payments, { fields: [refunds.paymentId], references: [payments.id] }),
  items: many(refundItems),
}));

export const refundItemsRelations = relations(refundItems, ({ one }) => ({
  refund: one(refunds, { fields: [refundItems.refundId], references: [refunds.id] }),
  orderItem: one(orderItems, { fields: [refundItems.orderItemId], references: [orderItems.id] }),
}));

// ───────────────────────────────────────────────────────────────── shipping

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
  carrier: one(carriers, { fields: [shipments.carrierId], references: [carriers.id] }),
  items: many(shipmentItems),
  events: many(shipmentEvents),
}));

export const shipmentItemsRelations = relations(shipmentItems, ({ one }) => ({
  shipment: one(shipments, { fields: [shipmentItems.shipmentId], references: [shipments.id] }),
  orderItem: one(orderItems, { fields: [shipmentItems.orderItemId], references: [orderItems.id] }),
}));

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, { fields: [shipmentEvents.shipmentId], references: [shipments.id] }),
}));

// ───────────────────────────────────────────────────────────────── aftersales, used, support

export const returnsRelations = relations(returns, ({ one, many }) => ({
  order: one(orders, { fields: [returns.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [returns.customerId], references: [customers.id] }),
  items: many(returnItems),
}));

export const returnItemsRelations = relations(returnItems, ({ one }) => ({
  returnRequest: one(returns, { fields: [returnItems.returnId], references: [returns.id] }),
  orderItem: one(orderItems, { fields: [returnItems.orderItemId], references: [orderItems.id] }),
  serial: one(serials, { fields: [returnItems.serialId], references: [serials.id] }),
}));

export const warrantiesRelations = relations(warranties, ({ one }) => ({
  orderItem: one(orderItems, { fields: [warranties.orderItemId], references: [orderItems.id] }),
  serial: one(serials, { fields: [warranties.serialId], references: [serials.id] }),
}));

export const repairTicketsRelations = relations(repairTickets, ({ one, many }) => ({
  customer: one(customers, { fields: [repairTickets.customerId], references: [customers.id] }),
  deviceModel: one(deviceModels, { fields: [repairTickets.deviceModelId], references: [deviceModels.id] }),
  warranty: one(warranties, { fields: [repairTickets.warrantyId], references: [warranties.id] }),
  events: many(repairEvents),
}));

export const repairEventsRelations = relations(repairEvents, ({ one }) => ({
  ticket: one(repairTickets, { fields: [repairEvents.ticketId], references: [repairTickets.id] }),
}));

export const usedUnitsRelations = relations(usedUnits, ({ one }) => ({
  variant: one(variants, { fields: [usedUnits.variantId], references: [variants.id] }),
  serial: one(serials, { fields: [usedUnits.serialId], references: [serials.id] }),
  location: one(inventoryLocations, { fields: [usedUnits.locationId], references: [inventoryLocations.id] }),
}));

export const tradeInsRelations = relations(tradeIns, ({ one, many }) => ({
  customer: one(customers, { fields: [tradeIns.customerId], references: [customers.id] }),
  deviceModel: one(deviceModels, { fields: [tradeIns.deviceModelId], references: [deviceModels.id] }),
  variant: one(variants, { fields: [tradeIns.variantId], references: [variants.id] }),
  events: many(tradeInEvents),
}));

export const tradeInEventsRelations = relations(tradeInEvents, ({ one }) => ({
  tradeIn: one(tradeIns, { fields: [tradeInEvents.tradeInId], references: [tradeIns.id] }),
}));

export const supportTicketsRelations = relations(supportTickets, ({ one, many }) => ({
  customer: one(customers, { fields: [supportTickets.customerId], references: [customers.id] }),
  order: one(orders, { fields: [supportTickets.orderId], references: [orders.id] }),
  messages: many(ticketMessages),
}));

export const ticketMessagesRelations = relations(ticketMessages, ({ one }) => ({
  ticket: one(supportTickets, { fields: [ticketMessages.ticketId], references: [supportTickets.id] }),
}));

export const knowledgeArticlesRelations = relations(knowledgeArticles, ({ one }) => ({
  deviceModel: one(deviceModels, { fields: [knowledgeArticles.deviceModelId], references: [deviceModels.id] }),
  platform: one(platforms, { fields: [knowledgeArticles.platformId], references: [platforms.id] }),
}));

// ───────────────────────────────────────────────────────────────── purchasing, accounting, staff, POS

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  purchaseOrders: many(purchaseOrders),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [purchaseOrders.supplierId], references: [suppliers.id] }),
  items: many(poItems),
  receipts: many(receipts),
}));

export const poItemsRelations = relations(poItems, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, { fields: [poItems.poId], references: [purchaseOrders.id] }),
  variant: one(variants, { fields: [poItems.variantId], references: [variants.id] }),
}));

export const receiptsRelations = relations(receipts, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrders, { fields: [receipts.poId], references: [purchaseOrders.id] }),
  items: many(receiptItems),
}));

export const receiptItemsRelations = relations(receiptItems, ({ one }) => ({
  receipt: one(receipts, { fields: [receiptItems.receiptId], references: [receipts.id] }),
  variant: one(variants, { fields: [receiptItems.variantId], references: [variants.id] }),
}));

export const journalEntriesRelations = relations(journalEntries, ({ many }) => ({
  lines: many(journalLines),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, { fields: [journalLines.entryId], references: [journalEntries.id] }),
  account: one(accounts, { fields: [journalLines.accountId], references: [accounts.id] }),
}));

export const employeesRelations = relations(employees, ({ many }) => ({
  employeeRoles: many(employeeRoles),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
  employeeRoles: many(employeeRoles),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
}));

export const employeeRolesRelations = relations(employeeRoles, ({ one }) => ({
  employee: one(employees, { fields: [employeeRoles.employeeId], references: [employees.id] }),
  role: one(roles, { fields: [employeeRoles.roleId], references: [roles.id] }),
}));

export const posRegistersRelations = relations(posRegisters, ({ many }) => ({
  shifts: many(posShifts),
}));

export const posShiftsRelations = relations(posShifts, ({ one, many }) => ({
  register: one(posRegisters, { fields: [posShifts.registerId], references: [posRegisters.id] }),
  cashMovements: many(cashMovements),
}));

export const cashMovementsRelations = relations(cashMovements, ({ one }) => ({
  shift: one(posShifts, { fields: [cashMovements.shiftId], references: [posShifts.id] }),
}));
