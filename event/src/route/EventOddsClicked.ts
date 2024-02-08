import express, { NextFunction, Request, Response } from "express";
import { body } from "express-validator";

import { Event } from "../model/Event";
import {
  BadRequestError,
  messengerWrapper,
  requireAuth,
} from "@betstan/common";
import EventOddsSelectedPublisher from "../messaging/publisher/EventOddsSelectedPublisher";

const router = express.Router();

router.post(
  "/api/event/odds",
  // requireAuth,
  [
    body("data").not().isEmpty().withMessage("Data parameter must exist"),
    body("eventId").not().isEmpty().withMessage("eventId must be provided"),
    body("oddsId").not().isEmpty().withMessage("oddsId must be provided"),
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    const { eventId, productId, oddsId } = req.body;

    const event = await Event.findOne({ eventId: eventId });

    if (!event) {
      return next(new BadRequestError("Event not found"));
    }

    const selectedProduct = event.products.find((eventProduct) => {
      if (eventProduct.id === productId) {
        return eventProduct;
      }
    });

    if (!selectedProduct) {
      return next(new BadRequestError("Product does not exist"));
    }

    const selectedOdds = selectedProduct.odds.find((eventOdds) => {
      if (eventOdds.id === oddsId) {
        return eventOdds;
      }
    });

    if (!selectedOdds) {
      return next(new BadRequestError("Odds does not exist"));
    }

    const publisher = new EventOddsSelectedPublisher(
      messengerWrapper.connection
    );
    await publisher.init();

    publisher.publish({
      data: {
        userId: req.currentUser ? req.currentUser.id : "",
        eventId: event.eventId,
        eventName: event.name,
        oddsId: selectedOdds.id,
        oddsValue: selectedOdds.value as number,
        oddsName: selectedOdds.name as string,
        productName: selectedProduct.name,
        productId: selectedProduct.id,
      },
    });

    res.sendStatus(200);
  }
);

export { router as EventOddsClicked };
