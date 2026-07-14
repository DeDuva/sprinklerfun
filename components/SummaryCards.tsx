"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface Props {
  totalGallons: number
  sprinklerGallons: number
  houseGallons: number
  estimatedCost: number
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function SummaryCards({ totalGallons, sprinklerGallons, houseGallons, estimatedCost }: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-sm text-gray-500 font-medium">Total Gallons</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{fmt(totalGallons)}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-sm text-gray-500 font-medium">Sprinkler Gallons</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold text-[#1B6FA8]">{fmt(sprinklerGallons)}</p>
          {totalGallons > 0 && (
            <p className="text-xs text-gray-400">{Math.round((sprinklerGallons / totalGallons) * 100)}% of total</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-sm text-gray-500 font-medium">House Gallons</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold text-[#B9822F]">{fmt(houseGallons)}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-sm text-gray-500 font-medium">Estimated Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold text-[#2E7D4F]">
            ${estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
