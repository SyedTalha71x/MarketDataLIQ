export const getUTCTimestamp = (): string => {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}${String(now.getUTCDate()).padStart(2, "0")}-${String(
    now.getUTCHours()
  ).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(
    now.getUTCSeconds()
  ).padStart(2, "0")}.${String(now.getUTCMilliseconds()).padStart(3, "0")}`;
};

export const calculateChecksum = (message: string): string => {
  let sum = 0;
  for (let i = 0; i < message.length; i++) {
    sum += message.charCodeAt(i);
  }
  return (sum % 256).toString().padStart(3, "0");
};


export const calculateLots = (quantity: number, contractSize: number): number => {
  console.log(
    `Calculating lots: ${quantity} / ${contractSize} = ${Math.round(
      quantity / contractSize
    )}`
  );
  return Math.round(quantity / contractSize);
};